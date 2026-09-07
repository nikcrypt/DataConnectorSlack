import "dotenv/config";
import http from "node:http";
import { SlackOAuth, loadOAuthConfigFromEnv } from "./connectors/slack/SlackOAuth.js";
import { saveSlackAuth, loadSlackAuth } from "./connectors/slack/tokenStore.js";

const pendingStates = new Map(); // state -> createdAt

function html(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1a1a1a; }
    a.button { display: inline-block; background: #4A154B; color: #fff; text-decoration: none; padding: 12px 18px; border-radius: 6px; }
    code, pre { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
    pre { padding: 12px; overflow: auto; }
    .ok { color: #0a7; }
    .err { color: #c22; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function main() {
  const config = loadOAuthConfigFromEnv();
  const oauth = new SlackOAuth(config);
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        const auth = await loadSlackAuth();
        const status = auth?.accessToken
          ? `<p class="ok">Authenticated for team <strong>${auth.team?.name || auth.team?.id}</strong>.</p>
             <p>Bot token is stored in <code>data/slack-auth.json</code>. You can run <code>npm run test:connection</code>.</p>`
          : `<p>Not authenticated yet.</p>`;

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          html(
            "Slack Connector Auth",
            `<h1>Slack Connector Auth</h1>
             ${status}
             <p><a class="button" href="/slack/install">Install / Re-authorize Slack App</a></p>
             <p>Redirect URI configured: <code>${config.redirectUri}</code></p>
             <p>Add this exact URL under Slack app → <strong>OAuth &amp; Permissions → Redirect URLs</strong>.</p>`
          )
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/slack/install") {
        const state = oauth.createState();
        pendingStates.set(state, Date.now());
        const installUrl = oauth.getInstallUrl(state);
        res.writeHead(302, { Location: installUrl });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/slack/oauth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html("OAuth error", `<h1 class="err">OAuth error</h1><p>${error}</p>`));
          return;
        }

        if (!code || !state || !pendingStates.has(state)) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            html(
              "Invalid OAuth callback",
              `<h1 class="err">Invalid OAuth callback</h1>
               <p>Missing code/state, or state expired. Start again from <a href="/slack/install">/slack/install</a>.</p>`
            )
          );
          return;
        }
        pendingStates.delete(state);

        const result = await oauth.exchangeCode(code);
        await saveSlackAuth(result);

        // Also write token into .env helper note — we keep file-based auth as source of truth
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          html(
            "Slack connected",
            `<h1 class="ok">Slack connected</h1>
             <p>Workspace: <strong>${result.team?.name || result.team?.id}</strong></p>
             <p>Bot user: <code>${result.botUserId || "n/a"}</code></p>
             <p>Scopes: <code>${result.scope || ""}</code></p>
             <p>Token saved. Next:</p>
             <pre>npm run test:connection
npm run extract</pre>
             <p>Invite the bot into channels with <code>/invite @YourBot</code>.</p>
             <p><a href="/">Back</a></p>`
          )
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      console.error("Auth server error:", err.message);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html("Error", `<h1 class="err">Error</h1><p>${escapeHtml(err.message)}</p>`));
    }
  });

  server.listen(port, () => {
    console.log(`Slack auth server listening on http://localhost:${port}`);
    console.log(`1. Add Redirect URL in Slack: ${config.redirectUri}`);
    console.log(`2. Open http://localhost:${port}/slack/install`);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
