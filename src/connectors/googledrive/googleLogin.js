import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { saveGoogleAuth } from "./tokenStore.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Open the Google account chooser, catch the redirect, and store a new refresh token.
 * Redirect URI must match the OAuth client, default http://localhost:3000/oauth2callback.
 */
export async function loginGoogleDrive({ clientId, clientSecret, redirectUri, scope }) {
  const redirect = new URL(redirectUri);
  const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
  const callbackPath = redirect.pathname || "/oauth2callback";
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const tokens = await waitForCallback({
    port,
    callbackPath,
    redirectUri,
    state,
    authUrl: authUrl.toString(),
    clientId,
    clientSecret,
  });

  const saved = await saveGoogleAuth(tokens);
  console.log("Google Drive token saved to data/google-auth.json");
  return saved;
}

function waitForCallback({ port, callbackPath, redirectUri, state, authUrl, clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(value);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h1>Google sign-in failed</h1><p>${escapeHtml(oauthError)}</p>`);
          finish(reject, new Error(`Google sign-in failed: ${oauthError}`));
          return;
        }

        if (url.searchParams.get("state") !== state) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("State mismatch");
          finish(reject, new Error("Google OAuth state mismatch"));
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing code");
          return;
        }

        const tokens = await exchangeCode({ clientId, clientSecret, redirectUri, code });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Google Drive connected</h1><p>You can close this tab and return to the terminal.</p>"
        );
        finish(resolve, tokens);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Token exchange failed");
        }
        finish(reject, err);
      }
    });

    const timer = setTimeout(() => {
      finish(reject, new Error("Google sign-in timed out after 3 minutes"));
    }, 3 * 60 * 1000);

    server.on("error", (err) => finish(reject, err));
    server.listen(port, "127.0.0.1", () => {
      console.log("\nGoogle Drive needs a sign-in. Open this URL if the browser does not:");
      console.log(authUrl);
      console.log("");
      openBrowser(authUrl);
    });
  });
}

async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google token exchange failed: ${data.error || ""} ${data.error_description || response.status}`.trim()
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    scope: data.scope || "",
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is already printed. A VM without a desktop can open it on a laptop.
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
