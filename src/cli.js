import "dotenv/config";
import { SlackConnector } from "./connectors/slack/SlackConnector.js";
import { PostgresConnector } from "./connectors/postgres/PostgresConnector.js";
import { ConnectorRuntimeEngine } from "./runtime/ConnectorRuntimeEngine.js";
import { loadSlackAuth, getBotTokenFromEnvOrAuth } from "./connectors/slack/tokenStore.js";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    connector: "slack",
    objects: null,
  };

  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--connector" && argv[i + 1]) {
      args.connector = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (argv[i] === "--objects" && argv[i + 1]) {
      args.objects = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }

  return args;
}

async function loadSlackConfig() {
  const auth = await loadSlackAuth();
  const botToken = getBotTokenFromEnvOrAuth(auth);

  if (!botToken) {
    throw new Error(
      "Missing SLACK_BOT_TOKEN. Set it in .env or run: npm run auth"
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

function createConnector(name) {
  switch (name) {
    case "slack":
      return loadSlackConfig().then((config) => new SlackConnector(config));
    case "postgres":
      return Promise.resolve(PostgresConnector.fromEnv());
    default:
      throw new Error(`Unknown connector: ${name}. Use slack or postgres.`);
  }
}

function defaultObjects(connectorKey) {
  if (connectorKey === "postgres") {
    return ["schemas", "tables", "views", "columns"];
  }
  return [
    "workspaces",
    "users",
    "userGroups",
    "channels",
    "messages",
    "threads",
    "reactions",
    "files",
  ];
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }

  if (args.command === "auth-status") {
    if (args.connector !== "slack") {
      console.log("auth-status is only for Slack.");
      process.exitCode = 1;
      return;
    }
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

  const connector = await createConnector(args.connector);

  if (args.command === "test") {
    const result = await connector.testConnection();
    console.log("Connection OK:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "extract") {
    const runtime = new ConnectorRuntimeEngine(connector);
    const objects = args.objects || defaultObjects(args.connector);
    await runtime.run({ objects, mode: "full" });
    return;
  }

  console.error(`Unknown command: ${args.command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp() {
  console.log(`
Data connector CLI

  npm run test:connection
  npm run test:connection -- --connector postgres
  npm run extract
  npm run extract -- --connector postgres
  npm run extract -- --connector postgres --objects schemas,tables,columns
  npm run extract:slack -- --objects users,channels
  npm run extract:postgres

Slack setup:
  SLACK_BOT_TOKEN in .env  (or npm run auth)

Postgres setup:
  POSTGRES_HOST, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD in .env
  (or POSTGRES_URL=postgresql://user:pass@host:5432/dbname)
  Optional: POSTGRES_SCHEMAS=public,app
  Optional: POSTGRES_SSL=true
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
