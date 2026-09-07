import "dotenv/config";
import { SlackConnector } from "./connectors/slack/SlackConnector.js";
import { ConnectorRuntimeEngine } from "./runtime/ConnectorRuntimeEngine.js";
import { loadSlackAuth, getBotTokenFromEnvOrAuth } from "./connectors/slack/tokenStore.js";

function parseArgs(argv) {
  const args = { command: argv[2] || "help", objects: null };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--objects" && argv[i + 1]) {
      args.objects = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return args;
}

async function loadConfig() {
  const auth = await loadSlackAuth();
  const botToken = getBotTokenFromEnvOrAuth(auth);

  if (!botToken) {
    throw new Error(
      "Not authenticated. Set SLACK_BOT_TOKEN in .env or run: npm run auth"
    );
  }

  const userToken =
    process.env.SLACK_USER_TOKEN?.startsWith("xoxp-")
      ? process.env.SLACK_USER_TOKEN
      : null;

  const historyDays = process.env.SLACK_HISTORY_DAYS
    ? Number(process.env.SLACK_HISTORY_DAYS)
    : null;

  const channelIds = process.env.SLACK_CHANNEL_IDS
    ? process.env.SLACK_CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return { botToken, userToken, historyDays, channelIds, team: auth?.team || null };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }

  if (args.command === "auth-status") {
    const auth = await loadSlackAuth();
    if (!auth?.accessToken) {
      console.log("Not authenticated. Run: npm run auth");
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          team: auth.team,
          botUserId: auth.botUserId,
          scope: auth.scope,
          installedAt: auth.installedAt,
          tokenPrefix: `${auth.accessToken.slice(0, 8)}...`,
        },
        null,
        2
      )
    );
    return;
  }

  const config = await loadConfig();
  const connector = new SlackConnector(config);

  if (args.command === "test") {
    const result = await connector.testConnection();
    console.log("Connection OK:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "extract") {
    const runtime = new ConnectorRuntimeEngine(connector);
    const objects = args.objects || [
      "workspaces",
      "users",
      "userGroups",
      "channels",
      "messages",
      "threads",
      "reactions",
      "files",
    ];
    await runtime.run({ objects, mode: "full" });
    return;
  }

  console.error(`Unknown command: ${args.command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp() {
  console.log(`
Slack connector CLI

  npm run auth                 Start OAuth server (install app → get bot token)
  npm run auth:status          Show saved auth (no secret printed in full)
  npm run test:connection      Call auth.test with saved bot token
  npm run extract              Extract all objects to data/output/
  npm run extract -- --objects users,channels

Setup:
  1. Put Client ID / Secret in .env (already done if provided)
  2. In Slack app → OAuth & Permissions:
       - Add Redirect URL: http://localhost:3000/slack/oauth/callback
       - Add Bot Token Scopes (see README)
  3. npm run auth  → open /slack/install → Allow
  4. /invite @YourBot into channels
  5. npm run test:connection && npm run extract
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
