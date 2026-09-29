/**
 * Box API v2 client.
 * Auth (pick one):
 *   1. Developer / bearer token — BOX_ACCESS_TOKEN
 *   2. Client Credentials Grant — BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID
 *      (or BOX_USER_ID for user-subject CCG)
 *   3. OAuth refresh token — BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN
 */
const TOKEN_URL = "https://api.box.com/oauth2/token";
const API_BASE = "https://api.box.com/2.0";

export class BoxClient {
  /**
   * @param {{
   *   accessToken?: string,
   *   clientId?: string,
   *   clientSecret?: string,
   *   enterpriseId?: string,
   *   userId?: string,
   *   refreshToken?: string,
   * }} config
   */
  constructor(config) {
    this.accessToken = config.accessToken || null;
    this.clientId = config.clientId || null;
    this.clientSecret = config.clientSecret || null;
    this.enterpriseId = config.enterpriseId || null;
    this.userId = config.userId || null;
    this.refreshToken = config.refreshToken || null;
    this.tokenExpiresAt = 0;

    const hasBearer = Boolean(this.accessToken);
    const hasCcg =
      Boolean(this.clientId) &&
      Boolean(this.clientSecret) &&
      (Boolean(this.enterpriseId) || Boolean(this.userId));
    const hasRefresh =
      Boolean(this.clientId) &&
      Boolean(this.clientSecret) &&
      Boolean(this.refreshToken);

    if (!hasBearer && !hasCcg && !hasRefresh) {
      throw new Error(
        "Missing Box auth. Set BOX_ACCESS_TOKEN, " +
          "or BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID (or BOX_USER_ID), " +
          "or BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN."
      );
    }
  }

  static fromEnv() {
    return new BoxClient({
      accessToken: process.env.BOX_ACCESS_TOKEN || null,
      clientId: process.env.BOX_CLIENT_ID || null,
      clientSecret: process.env.BOX_CLIENT_SECRET || null,
      enterpriseId: process.env.BOX_ENTERPRISE_ID || null,
      userId: process.env.BOX_USER_ID || null,
      refreshToken: process.env.BOX_REFRESH_TOKEN || null,
    });
  }

  async authenticate() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    // Explicit bearer with no refresh capability
    if (
      this.accessToken &&
      !this.refreshToken &&
      !(this.clientId && this.clientSecret && (this.enterpriseId || this.userId))
    ) {
      return this.accessToken;
    }

    if (this.clientId && this.clientSecret && (this.enterpriseId || this.userId)) {
      return this.authenticateCcg();
    }

    if (this.refreshToken) {
      return this.authenticateRefreshToken();
    }

    return this.accessToken;
  }

  async authenticateCcg() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      box_subject_type: this.userId ? "user" : "enterprise",
      box_subject_id: this.userId || this.enterpriseId,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Box CCG auth failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async authenticateRefreshToken() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Box refresh auth failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  /**
   * @param {string} pathOrUrl
   * @param {{ query?: Record<string, string|number|boolean|undefined> }} [options]
   */
  async request(pathOrUrl, options = {}) {
    await this.authenticate();

    let url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${API_BASE}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

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
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
      });

      if (response.status === 401 && attempt === 0) {
        this.tokenExpiresAt = 0;
        await this.authenticate();
        attempt += 1;
        continue;
      }

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After") || 2);
        attempt += 1;
        if (attempt > 5) {
          throw new Error(`Box rate limited on ${pathOrUrl}`);
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
          data.error_description ||
          data.error ||
          data.code ||
          `HTTP ${response.status}`;
        throw new Error(`Box ${pathOrUrl} failed: ${msg}`);
      }

      return data;
    }
  }

  async testConnection() {
    const me = await this.request("/users/me");
    return {
      ok: true,
      id: me.id,
      name: me.name || null,
      login: me.login || null,
      type: me.type || null,
      enterprise: me.enterprise
        ? { id: me.enterprise.id, name: me.enterprise.name }
        : null,
    };
  }

  /**
   * Offset-paginated list endpoints that return { entries, total_count, offset, limit }.
   * @param {string} path
   * @param {Record<string, string|number|boolean|undefined>} [query]
   * @param {number} [pageSize]
   */
  async *paginate(path, query = {}, pageSize = 100) {
    let offset = 0;

    while (true) {
      const page = await this.request(path, {
        query: { ...query, limit: pageSize, offset },
      });
      const entries = page.entries || [];
      for (const entry of entries) {
        yield entry;
      }
      offset += entries.length;
      const total = page.total_count;
      if (!entries.length) break;
      if (typeof total === "number" && offset >= total) break;
      if (entries.length < pageSize) break;
    }
  }

  async *listUsers(pageSize = 100) {
    yield* this.paginate("/users", { fields: "id,name,login,status,type,role,created_at,modified_at,space_amount,space_used,enterprise" }, pageSize);
  }

  /**
   * List items in a folder (files + folders).
   */
  async *listFolderItems(folderId, pageSize = 100) {
    yield* this.paginate(
      `/folders/${encodeURIComponent(folderId)}/items`,
      {
        fields:
          "id,type,name,size,created_at,modified_at,created_by,modified_by,owned_by,parent,path_collection,shared_link,item_status,sha1,extension,description",
      },
      pageSize
    );
  }

  async getFolder(folderId) {
    return this.request(`/folders/${encodeURIComponent(folderId)}`, {
      query: {
        fields:
          "id,type,name,size,created_at,modified_at,created_by,modified_by,owned_by,parent,path_collection,shared_link,item_status,description,item_collection",
      },
    });
  }

  async *listCollaborations(folderId, pageSize = 100) {
    yield* this.paginate(
      `/folders/${encodeURIComponent(folderId)}/collaborations`,
      {
        fields:
          "id,type,role,status,created_at,modified_at,accessible_by,created_by,invite_email,expires_at",
      },
      pageSize
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
