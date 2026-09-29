/**
 * Confluence Cloud REST client (API v2).
 * Auth: Basic (email + API token) — same Atlassian Cloud pattern as Jira.
 * Site root is https://your-domain.atlassian.net (paths are under /wiki).
 */

export class ConfluenceClient {
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
        "Missing Confluence config. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN " +
          "(or reuse JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN on the same site)."
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "").replace(/\/wiki$/, "");
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.authHeader =
      "Basic " + Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");
  }

  static fromEnv() {
    return new ConfluenceClient({
      baseUrl: process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL,
      email: process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL,
      apiToken: process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN,
    });
  }

  /**
   * @param {string} pathOrUrl
   * @param {{ query?: Record<string, string|number|boolean|undefined> }} [options]
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
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After") || 2);
        attempt += 1;
        if (attempt > 5) {
          throw new Error(`Confluence rate limited on ${pathOrUrl}`);
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
          data.message ||
          data.errorMessages?.join?.("; ") ||
          data.error ||
          `HTTP ${response.status}`;
        throw new Error(`Confluence ${pathOrUrl} failed: ${msg}`);
      }

      return data;
    }
  }

  async testConnection() {
    const me = await this.request("/wiki/rest/api/user/current");
    return {
      ok: true,
      accountId: me.accountId || null,
      displayName: me.displayName || me.publicName || null,
      email: me.email || null,
      baseUrl: this.baseUrl,
    };
  }

  /**
   * Cursor pagination used by Confluence REST API v2 (`results` + `_links.next`).
   * @param {string} path
   * @param {Record<string, string|number|boolean|undefined>} [query]
   * @param {number} [pageSize]
   * @param {number} [maxItems]
   */
  async *paginate(path, query = {}, pageSize = 50, maxItems = Infinity) {
    let nextUrl = null;
    let count = 0;
    let first = true;

    while (true) {
      const page = first
        ? await this.request(path, { query: { ...query, limit: pageSize } })
        : await this.request(nextUrl);

      first = false;
      const results = page.results || [];
      for (const item of results) {
        yield item;
        count += 1;
        if (count >= maxItems) return;
      }

      const next = page._links?.next;
      if (!next || !results.length) break;
      nextUrl = next.startsWith("http") ? next : `${this.baseUrl}${next}`;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
