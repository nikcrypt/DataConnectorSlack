/**
 * Google Drive API v3 client.
 * Auth (pick one):
 *   1. Service account JSON  — GOOGLE_SERVICE_ACCOUNT_FILE
 *   2. OAuth refresh token  — GOOGLE_CLIENT_ID + SECRET + REFRESH_TOKEN
 *   3. Bearer access token  — GOOGLE_ACCESS_TOKEN
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "parents",
  "owners(displayName,emailAddress,permissionId)",
  "createdTime",
  "modifiedTime",
  "size",
  "md5Checksum",
  "sha1Checksum",
  "webViewLink",
  "webContentLink",
  "shared",
  "starred",
  "trashed",
  "driveId",
  "spaces",
  "shortcutDetails",
  "capabilities",
].join(",");

export class GoogleDriveClient {
  /**
   * @param {{
   *   accessToken?: string,
   *   serviceAccountFile?: string,
   *   impersonateUser?: string,
   *   clientId?: string,
   *   clientSecret?: string,
   *   refreshToken?: string,
   *   scope?: string,
   * }} config
   */
  constructor(config) {
    this.accessToken = config.accessToken || null;
    this.serviceAccountFile = config.serviceAccountFile || null;
    this.impersonateUser = config.impersonateUser || null;
    this.clientId = config.clientId || null;
    this.clientSecret = config.clientSecret || null;
    this.refreshToken = config.refreshToken || null;
    this.scope = config.scope || DEFAULT_SCOPE;
    this.tokenExpiresAt = 0;

    const hasSa = Boolean(this.serviceAccountFile);
    const hasRefresh =
      Boolean(this.clientId) &&
      Boolean(this.clientSecret) &&
      Boolean(this.refreshToken);
    const hasBearer = Boolean(this.accessToken);

    if (!hasSa && !hasRefresh && !hasBearer) {
      throw new Error(
        "Missing Google Drive auth. Set GOOGLE_SERVICE_ACCOUNT_FILE, " +
          "or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN, " +
          "or GOOGLE_ACCESS_TOKEN."
      );
    }
  }

  static fromEnv() {
    return new GoogleDriveClient({
      accessToken: process.env.GOOGLE_ACCESS_TOKEN || null,
      serviceAccountFile:
        process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        null,
      impersonateUser: process.env.GOOGLE_IMPERSONATE_USER || null,
      clientId: process.env.GOOGLE_CLIENT_ID || null,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN || null,
      scope: process.env.GOOGLE_DRIVE_SCOPE || DEFAULT_SCOPE,
    });
  }

  async authenticate() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    // Explicit bearer from env — no refresh
    if (
      this.accessToken &&
      !this.serviceAccountFile &&
      !this.refreshToken
    ) {
      return this.accessToken;
    }

    if (this.serviceAccountFile) {
      return this.authenticateServiceAccount();
    }

    if (this.refreshToken) {
      return this.authenticateRefreshToken();
    }

    return this.accessToken;
  }

  async authenticateServiceAccount() {
    const keyPath = path.resolve(this.serviceAccountFile);
    const sa = JSON.parse(readFileSync(keyPath, "utf8"));
    if (!sa.client_email || !sa.private_key) {
      throw new Error(
        `Invalid service account file ${keyPath}: need client_email and private_key`
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" })
    ).toString("base64url");

    const claim = {
      iss: sa.client_email,
      scope: this.scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    };
    if (this.impersonateUser) {
      claim.sub = this.impersonateUser;
    }

    const claimB64 = Buffer.from(JSON.stringify(claim)).toString("base64url");
    const unsigned = `${header}.${claimB64}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(sa.private_key, "base64url");
    const assertion = `${unsigned}.${signature}`;

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Google SA auth failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async authenticateRefreshToken() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Google refresh auth failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
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
      : `${DRIVE_BASE}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

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
          throw new Error(`Google Drive rate limited on ${pathOrUrl}`);
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
        throw new Error(`Google Drive ${pathOrUrl} failed: ${msg}`);
      }

      return data;
    }
  }

  async testConnection() {
    const about = await this.request("/about", {
      query: { fields: "user,storageQuota" },
    });
    return {
      ok: true,
      user: about.user || null,
      storageQuota: about.storageQuota || null,
    };
  }

  /**
   * List shared drives (Team Drives).
   */
  async *listDrives(pageSize = 50) {
    let pageToken;
    while (true) {
      const page = await this.request("/drives", {
        query: {
          pageSize,
          pageToken,
          fields: "nextPageToken,drives(id,name,kind,createdTime,restrictions)",
        },
      });
      for (const drive of page.drives || []) {
        yield drive;
      }
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
  }

  /**
   * List files/folders. Metadata only — no content download.
   * @param {{ q?: string, corpora?: string, driveId?: string, pageSize?: number, maxItems?: number }} [opts]
   */
  async *listFiles(opts = {}) {
    const pageSize = opts.pageSize ?? 100;
    const maxItems = opts.maxItems ?? Infinity;
    let pageToken;
    let count = 0;

    const query = {
      pageSize,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: opts.q,
      corpora: opts.corpora || "user",
      driveId: opts.driveId,
    };

    // Shared drive listing requires corpora=drive + driveId
    if (opts.driveId) {
      query.corpora = "drive";
    }

    while (true) {
      const page = await this.request("/files", {
        query: { ...query, pageToken },
      });

      for (const file of page.files || []) {
        yield file;
        count += 1;
        if (count >= maxItems) return;
      }

      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
  }

  /**
   * Permissions for a file/folder.
   */
  async *listPermissions(fileId, pageSize = 100) {
    let pageToken;
    while (true) {
      const page = await this.request(`/files/${encodeURIComponent(fileId)}/permissions`, {
        query: {
          pageSize,
          pageToken,
          supportsAllDrives: true,
          fields:
            "nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,allowFileDiscovery)",
        },
      });
      for (const perm of page.permissions || []) {
        yield perm;
      }
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
