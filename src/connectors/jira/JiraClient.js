/**
 * Jira Cloud REST client.
 * Auth: Basic (email + API token) — standard Atlassian Cloud POC pattern.
 */

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
   * @param {{ query?: Record<string, string|number|boolean|undefined>, method?: string, body?: object }} [options]
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
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After") || 2);
        attempt += 1;
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

  async testConnection() {
    const me = await this.request("/rest/api/3/myself");
    return {
      ok: true,
      accountId: me.accountId,
      displayName: me.displayName,
      emailAddress: me.emailAddress || null,
      baseUrl: this.baseUrl,
    };
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

      const items = page[listKey] || [];
      for (const item of items) {
        yield item;
      }

      const total = page.total;
      startAt += items.length;

      if (!items.length) break;
      if (typeof total === "number" && startAt >= total) break;
      if (items.length < pageSize) break;
    }
  }

  /**
   * Issue search with JQL via /rest/api/3/search/jql (token pagination).
   * Legacy /rest/api/3/search was removed (CHANGE-2046).
   * @param {string} jql
   * @param {string[]} [fields]
   * @param {number} [pageSize]
   */
  async *searchIssues(
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
    pageSize = 50
  ) {
    let nextPageToken;

    while (true) {
      const page = await this.request("/rest/api/3/search/jql", {
        query: {
          jql,
          maxResults: pageSize,
          fields: fields.join(","),
          nextPageToken,
        },
      });

      const issues = page.issues || [];
      for (const issue of issues) {
        yield issue;
      }

      nextPageToken = page.nextPageToken;
      if (!nextPageToken || !issues.length || page.isLast === true) break;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
