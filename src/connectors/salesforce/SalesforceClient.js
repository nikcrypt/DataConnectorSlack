/**
 * Salesforce REST client (OAuth + Data API).
 * Auth modes (first match wins):
 *  1) Access token + instance URL (SF_ACCESS_TOKEN / SALESFORCE_ACCESS_TOKEN)
 *  2) Password grant (username + password + optional security token)
 *  3) Client credentials grant
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_API_VERSION = "v59.0";

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

export class SalesforceClient {
  /**
   * @param {object} config
   */
  constructor(config) {
    this.loginUrl = (config.loginUrl || "https://login.salesforce.com").replace(/\/$/, "");
    this.clientId = config.clientId || "";
    this.clientSecret = config.clientSecret || "";
    this.username = config.username || "";
    this.password = config.password || "";
    this.securityToken = config.securityToken || "";
    this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    this.privateKeyPath = config.privateKeyPath || "";
    this.accessToken = config.accessToken || null;
    this.instanceUrl = config.instanceUrl ? config.instanceUrl.replace(/\/$/, "") : null;
  }

  static fromEnv() {
    return new SalesforceClient({
      loginUrl: env("SALESFORCE_LOGIN_URL", "SF_LOGIN_URL") || "https://login.salesforce.com",
      clientId: env("SALESFORCE_CLIENT_ID", "SF_CLIENT_ID"),
      clientSecret: env("SALESFORCE_CLIENT_SECRET", "SF_CLIENT_SECRET"),
      username: env("SALESFORCE_USERNAME", "SF_USERNAME"),
      password: env("SALESFORCE_PASSWORD", "SF_PASSWORD"),
      securityToken: env("SALESFORCE_SECURITY_TOKEN", "SF_SECURITY_TOKEN"),
      apiVersion: env("SALESFORCE_API_VERSION") || DEFAULT_API_VERSION,
      privateKeyPath: env("SALESFORCE_PRIVATE_KEY_PATH", "SF_PRIVATE_KEY_PATH"),
      accessToken: env("SALESFORCE_ACCESS_TOKEN", "SF_ACCESS_TOKEN"),
      instanceUrl: env("SALESFORCE_INSTANCE_URL", "SF_INSTANCE_URL"),
    });
  }

  async authenticate() {
    if (this.accessToken && this.instanceUrl) {
      return { accessToken: this.accessToken, instanceUrl: this.instanceUrl };
    }

    if (this.privateKeyPath && this.clientId && this.username) {
      return this.authenticateJwt();
    }

    if (!this.clientId) {
      throw new Error(
        "Missing Salesforce auth. Set SF_ACCESS_TOKEN + SF_INSTANCE_URL, or CLIENT_ID with password/JWT/client_credentials."
      );
    }

    const tokenUrl = `${this.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
    });

    if (this.clientSecret) {
      body.set("client_secret", this.clientSecret);
    }

    if (this.username && this.password) {
      body.set("grant_type", "password");
      body.set("username", this.username);
      body.set("password", `${this.password}${this.securityToken || ""}`);
    } else if (this.clientSecret) {
      body.set("grant_type", "client_credentials");
    } else {
      throw new Error(
        "Cannot authenticate: provide ACCESS_TOKEN+INSTANCE_URL, or password grant, or client_secret, or JWT private key."
      );
    }

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Salesforce auth failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
    this.instanceUrl = (data.instance_url || "").replace(/\/$/, "");
    if (!this.instanceUrl) {
      throw new Error("Salesforce auth succeeded but instance_url was missing");
    }

    return { accessToken: this.accessToken, instanceUrl: this.instanceUrl };
  }

  async authenticateJwt() {
    const keyPath = path.resolve(this.privateKeyPath);
    const privateKey = readFileSync(keyPath, "utf8");
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claim = Buffer.from(
      JSON.stringify({
        iss: this.clientId,
        sub: this.username,
        aud: this.loginUrl,
        exp: now + 3 * 60,
      })
    ).toString("base64url");

    const unsigned = `${header}.${claim}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(privateKey, "base64url");
    const assertion = `${unsigned}.${signature}`;

    const tokenUrl = `${this.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(
        `Salesforce JWT auth failed: ${data.error_description || data.error || response.status}`
      );
    }

    this.accessToken = data.access_token;
    this.instanceUrl = (data.instance_url || "").replace(/\/$/, "");
    return { accessToken: this.accessToken, instanceUrl: this.instanceUrl };
  }

  apiPath(pathSuffix) {
    const p = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
    return `/services/data/${this.apiVersion}${p}`;
  }

  /**
   * @param {string} pathOrUrl
   * @param {{ query?: Record<string, string|number|boolean|undefined> }} [options]
   */
  async request(pathOrUrl, options = {}) {
    await this.authenticate();

    let url;
    if (pathOrUrl.startsWith("http")) {
      url = pathOrUrl;
    } else if (pathOrUrl.startsWith("/services/")) {
      url = `${this.instanceUrl}${pathOrUrl}`;
    } else {
      url = `${this.instanceUrl}${this.apiPath(pathOrUrl)}`;
    }

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

      if (response.status === 401 && attempt === 0 && this.privateKeyPath) {
        // Try refresh via JWT if bearer expired
        this.accessToken = null;
        this.instanceUrl = this.instanceUrl; // keep known instance if set
        await this.authenticateJwt();
        attempt += 1;
        continue;
      }

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After") || 2);
        attempt += 1;
        if (attempt > 5) {
          throw new Error(`Salesforce rate limited on ${pathOrUrl}`);
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
        const msg = Array.isArray(data)
          ? data.map((e) => e.message || e.errorCode).join("; ")
          : data[0]?.message || data.message || data.error || `HTTP ${response.status}`;
        throw new Error(`Salesforce ${pathOrUrl} failed: ${msg}`);
      }

      return data;
    }
  }

  async testConnection() {
    const auth = await this.authenticate();
    try {
      const identity = await this.request(`${auth.instanceUrl}/services/oauth2/userinfo`);
      return {
        ok: true,
        instanceUrl: auth.instanceUrl,
        apiVersion: this.apiVersion,
        userId: identity.user_id || null,
        organizationId: identity.organization_id || null,
        preferredUsername: identity.preferred_username || null,
      };
    } catch {
      const sobjects = await this.request("/sobjects");
      return {
        ok: true,
        instanceUrl: auth.instanceUrl,
        apiVersion: this.apiVersion,
        sobjectCount: (sobjects.sobjects || []).length,
      };
    }
  }

  async listSObjects() {
    const data = await this.request("/sobjects");
    return data.sobjects || [];
  }

  async describeSObject(name) {
    return this.request(`/sobjects/${encodeURIComponent(name)}/describe`);
  }

  /**
   * @param {string} soql
   */
  async *query(soql) {
    let data = await this.request("/query", { query: { q: soql } });

    while (true) {
      for (const record of data.records || []) {
        yield record;
      }
      if (data.done || !data.nextRecordsUrl) break;
      data = await this.request(data.nextRecordsUrl);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
