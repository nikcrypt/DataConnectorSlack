const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

/**
 * Microsoft Graph client for SharePoint Online (client credentials).
 * Handles token acquisition, Graph calls, and @odata.nextLink pagination.
 */
export class SharePointClient {
  /**
   * @param {{
   *   tenantId: string,
   *   clientId: string,
   *   clientSecret: string,
   * }} config
   */
  constructor(config) {
    if (!config.tenantId || !config.clientId || !config.clientSecret) {
      throw new Error(
        "Missing SharePoint/Entra config. Set SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET."
      );
    }
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  static fromEnv() {
    return new SharePointClient({
      tenantId: process.env.SHAREPOINT_TENANT_ID,
      clientId: process.env.SHAREPOINT_CLIENT_ID,
      clientSecret: process.env.SHAREPOINT_CLIENT_SECRET,
    });
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await fetch(TOKEN_URL(this.tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Entra token request failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + Number(data.expires_in || 3599) * 1000;
    return this.accessToken;
  }

  /**
   * @param {string} pathOrUrl Graph path (/sites/...) or absolute nextLink URL
   * @param {{ method?: string, query?: Record<string, string|number|boolean|undefined> }} [options]
   */
  async request(pathOrUrl, options = {}) {
    const token = await this.getAccessToken();
    let url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${GRAPH_BASE}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

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
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After") || 2);
        attempt += 1;
        if (attempt > 5) {
          throw new Error(`Graph rate limited on ${pathOrUrl} after retries`);
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
          data.error?.message ||
          data.error_description ||
          data.error ||
          `HTTP ${response.status}`;
        throw new Error(`Graph ${pathOrUrl} failed: ${msg}`);
      }

      return data;
    }
  }

  /**
   * Follow @odata.nextLink until exhausted.
   * @param {string} path
   * @param {string} listKey usually "value"
   * @param {Record<string, string|number|boolean|undefined>} [query]
   */
  async *paginate(path, listKey = "value", query = {}) {
    let next = null;
    let first = true;

    while (first || next) {
      const page = first
        ? await this.request(path, { query })
        : await this.request(next);
      first = false;

      const items = page[listKey] || [];
      for (const item of items) {
        yield item;
      }

      next = page["@odata.nextLink"] || null;
    }
  }

  /**
   * Resolve a site by hostname + server-relative path.
   * Example hostname: contoso.sharepoint.com
   * Example sitePath: /sites/engineering
   */
  async getSiteByPath(hostname, sitePath) {
    const relative = sitePath.startsWith("/") ? sitePath : `/${sitePath}`;
    // Graph: /sites/{hostname}:/{server-relative-path}
    const encoded = `${hostname}:${relative}`;
    return this.request(`/sites/${encoded}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
