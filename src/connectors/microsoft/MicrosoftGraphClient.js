const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

/**
 * Shared Microsoft Graph client (client credentials).
 * Used by OneDrive (and other Graph-based connectors).
 */
export class MicrosoftGraphClient {
  /**
   * @param {{
   *   tenantId?: string,
   *   clientId?: string,
   *   clientSecret?: string,
   * }} config
   */
  constructor(config = {}) {
    if (!config.tenantId || !config.clientId || !config.clientSecret) {
      throw new Error(
        "Missing Microsoft Graph config. Set ONEDRIVE_TENANT_ID, ONEDRIVE_CLIENT_ID, and ONEDRIVE_CLIENT_SECRET."
      );
    }
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
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

    const response = await graphFetch(TOKEN_URL(this.tenantId), {
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
   * @param {string} pathOrUrl Graph path or absolute nextLink / deltaLink URL
   * @param {{ method?: string, query?: Record<string, string|number|boolean|undefined>, requestName?: string }} [options]
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

    const label = options.requestName || pathOrUrl;
    let attempt = 0;
    while (true) {
      const response = await graphFetch(url, {
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
          throw new Error(`Graph rate limited on ${label} after retries`);
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
        throw new Error(`Graph ${label} failed: ${msg}`);
      }

      return data;
    }
  }

  /**
   * Yield each Graph page object (keeps @odata.deltaLink for callers).
   * Follows @odata.nextLink only.
   * @param {string} pathOrUrl
   * @param {{ requestName?: string, query?: Record<string, string|number|boolean|undefined> }} [options]
   */
  async *paginatePages(pathOrUrl, options = {}) {
    let next = pathOrUrl;
    let first = true;

    while (next) {
      const page = first
        ? await this.request(next, {
            query: options.query,
            requestName: options.requestName,
          })
        : await this.request(next, { requestName: options.requestName });
      first = false;
      yield page;
      next = page["@odata.nextLink"] || null;
    }
  }
}

function graphFetch(url, options) {
  return fetch(url, options).catch((err) => {
    const cause = err.cause;
    const detail = cause?.code || cause?.message || err.message;
    const host = new URL(url).host;
    throw new Error(`Microsoft Graph network error calling ${host}: ${detail}`);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
