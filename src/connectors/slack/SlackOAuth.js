import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const ACCESS_URL = "https://slack.com/api/oauth.v2.access";

/**
 * Slack OAuth 2.0 helpers for app install → bot token.
 */
export class SlackOAuth {
  /**
   * @param {{
   *   clientId: string,
   *   clientSecret: string,
   *   redirectUri: string,
   *   scopes: string[],
   *   signingSecret?: string,
   * }} config
   */
  constructor(config) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.scopes = config.scopes;
    this.signingSecret = config.signingSecret || "";
  }

  createState() {
    return randomBytes(16).toString("hex");
  }

  getInstallUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scopes.join(","),
      redirect_uri: this.redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Exchange temporary OAuth code for bot access token.
   * @param {string} code
   */
  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    });

    const response = await fetch(ACCESS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`oauth.v2.access failed: ${data.error}`);
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      scope: data.scope,
      botUserId: data.bot_user_id,
      appId: data.app_id,
      team: data.team,
      authedUser: data.authed_user,
      installedAt: new Date().toISOString(),
      raw: data,
    };
  }

  /**
   * Verify Slack request signature (for Events API / slash commands later).
   * @param {string} signatureHeader
   * @param {string} timestampHeader
   * @param {string} rawBody
   */
  verifySlackSignature(signatureHeader, timestampHeader, rawBody) {
    if (!this.signingSecret) return false;
    if (!signatureHeader || !timestampHeader) return false;

    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts)) return false;
    // Reject requests older than 5 minutes
    if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;

    const base = `v0:${timestampHeader}:${rawBody}`;
    const digest = createHmac("sha256", this.signingSecret).update(base).digest("hex");
    const computed = `v0=${digest}`;

    const a = Buffer.from(computed);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

export function loadOAuthConfigFromEnv() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_REDIRECT_URI || "http://localhost:3000/slack/oauth/callback";
  const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
  const scopes = (process.env.SLACK_BOT_SCOPES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!clientId || !clientSecret) {
    throw new Error("Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET in .env");
  }
  if (!scopes.length) {
    throw new Error("Missing SLACK_BOT_SCOPES in .env");
  }

  return { clientId, clientSecret, redirectUri, signingSecret, scopes };
}
