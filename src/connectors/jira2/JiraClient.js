/**
 * Jira Cloud REST client.
 * Auth: Basic (email + API token) — standard Atlassian Cloud POC pattern.
 */
import loggerFactory from "../../logger.js";

const logger = loggerFactory.component("Jira", {
  connector: "Jira"
});

export class JiraClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   email: string,
   *   apiToken: string,
   * }} config
   */
  constructor(config) {
    if (!config.baseUrl || !config.email || !config.apiToken) {
      throw new Error(
        "Missing Jira config. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN."
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.authHeader =
      "Basic " + Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");
  }

  static fromEnv() {
    return new JiraClient({
      baseUrl: process.env.JIRA_BASE_URL,
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
    });
  }

  /**
   * @param {string} pathOrUrl
   * @param {{ query?: Record<string, string|number|boolean|undefined>, method?: string, body?: object, timeoutMs?: number }} [options]
   */
  async request(pathOrUrl, options = {}) {
    let url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

    if (options.query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === "") continue;
        qs.set(key, String(value));
      }
      const q = qs.toString();
      if (q) url += (url.includes("?") ? "&" : "?") + q;
    }

    let attempt = 0;
    while (true) {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After") || 2);
        attempt += 1;
          logger.warn("RateLimitHit", {
    endpoint: pathOrUrl,
    status: response.status,
    retryAfter,
    attempt
  });
        if (attempt > 5) {
          throw new Error(`Jira rate limited on ${pathOrUrl}`);
        }
        await sleep(retryAfter * 1000);
        continue;
      }

      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const msg =
          data.errorMessages?.join("; ") ||
          data.message ||
          data.error ||
          `HTTP ${response.status}`;
        throw new Error(`Jira ${pathOrUrl} failed: ${msg}`);
      }

      return data;
    }
  }

  async parseJql(endpoint, jql) {
    let data;
    try {
      data = await this.request(endpoint, {
        method: "POST",
        query: { validation: "strict" },
        body: { queries: [jql] },
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw new Error(`Jira JQL validation failed: ${error.message}`, { cause: error });
    }

    if (!Array.isArray(data?.queries) || data.queries.length !== 1) {
      throw new Error("Jira JQL validation returned an unexpected response");
    }
    const result = data.queries[0];
    for (const key of ["errors", "warnings"]) {
      const messages = result?.[key];
      if (messages !== undefined) {
        if (!Array.isArray(messages) || messages.some((message) => typeof message !== "string")) {
          throw new Error("Jira JQL validation returned an unexpected response");
        }
        if (messages.length) {
          throw new Error(`JQL validation ${key}: ${messages.join("; ")}`);
        }
      }
    }
    if (!result?.structure || typeof result.structure !== "object" || Array.isArray(result.structure)
      || (!result.structure.where && !result.structure.orderBy)) {
      throw new Error("Jira JQL validation did not return a parsed query structure");
    }
    return result.structure;
  }

  async testConnection() {
    const me = await this.request("/rest/api/3/myself");
    return {
      ok: true,
      accountId: me.accountId,
      displayName: me.displayName,
      emailAddress: me.emailAddress || null,
      baseUrl: this.baseUrl,
    };
    logger.info("ConnectionTestSucceeded", {
  accountId: me.accountId
});
  }

  /**
   * Paginate Jira startAt/maxResults style responses.
   * @param {string} path
   * @param {string} listKey
   * @param {Record<string, string|number|boolean|undefined>} [query]
   * @param {number} [pageSize]
   */
  async *paginate(path, listKey, query = {}, pageSize = 50) {
    let startAt = 0;

    while (true) {
      const page = await this.request(path, {
        query: { ...query, startAt, maxResults: pageSize },
      });

      if (!page || !Array.isArray(page[listKey])) {
        throw new Error(`Jira ${path} page at startAt ${startAt} does not contain a ${listKey} array`);
      }
      if (page.startAt !== undefined && page.startAt !== startAt) {
        throw new Error(`Jira ${path} pagination did not advance to startAt ${startAt}`);
      }
      if (page.isLast !== undefined && typeof page.isLast !== "boolean") {
        throw new Error(`Jira ${path} page at startAt ${startAt} has an invalid isLast value`);
      }
      const total = page.total;
      if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) {
        throw new Error(`Jira ${path} page at startAt ${startAt} has an invalid total`);
      }
      const items = page[listKey];
      const nextStartAt = startAt + items.length;
      if ((!items.length && page.isLast === false)
        || (typeof total === "number" && nextStartAt < total
          && (!items.length || page.isLast === true))) {
        throw new Error(`Jira ${path} pagination stopped before all projects were returned`);
      }
      for (const item of items) {
        yield item;
      }

      startAt = nextStartAt;
      if (page.isLast === true) return;
      if (page.isLast === false) continue;
      if (typeof total === "number") {
        if (startAt >= total) return;
        continue;
      }
      if (!items.length) return;
    }
  }

  /**
   * Issue search with JQL using the configured token-pagination endpoint.
   * Legacy /rest/api/3/search was removed (CHANGE-2046).
   * @param {string} path
   * @param {string} jql
   * @param {string[]} [fields]
   * @param {number} [pageSize]
   * @param {{ method?: "GET" | "POST" }} [options]
   */
  async *searchIssues(
    path,
    jql,
    fields = [
      "summary",
      "status",
      "assignee",
      "reporter",
      "priority",
      "issuetype",
      "project",
      "created",
      "updated",
      "labels",
      "description",
    ],
    pageSize = 50,
    options = {}
  ) {
    const method = options.method || "GET";
    if (method !== "GET" && method !== "POST") {
      throw new Error("Jira issue search supports GET or POST");
    }
    let nextPageToken;
    let pageNumber = 1;

    while (true) {
      const parameters = { jql, maxResults: pageSize, nextPageToken };
      const page = await this.request(path, method === "POST"
        ? { method, body: { ...parameters, fields } }
        : { query: { ...parameters, fields: fields.join(",") } });

      if (!page || !Array.isArray(page.issues)) {
        throw new Error(
          `Jira issue search page ${pageNumber} does not contain an issues array`
        );
      }

      const issues = page.issues;
      const isLastPage = page.isLast === true;
      const newPageToken = page.nextPageToken;

      if (!isLastPage && !newPageToken) {
        throw new Error(
          `Jira issue search page ${pageNumber} did not provide a next page token`
        );
      }
      if (!isLastPage && newPageToken === nextPageToken) {
        throw new Error(`Jira issue pagination did not advance after page ${pageNumber}`);
      }

      for (const issue of issues) {
        yield issue;
      }

      if (isLastPage) return;

      nextPageToken = newPageToken;
      pageNumber += 1;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
