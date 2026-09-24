import "dotenv/config";
import { SlackConnector } from "./connectors/slack/SlackConnector.js";
import { PostgresConnector } from "./connectors/postgres/PostgresConnector.js";
import { SharePointConnector } from "./connectors/sharepoint/SharePointConnector.js";
import { SalesforceConnector } from "./connectors/salesforce/SalesforceConnector.js";
import { JiraConnector } from "./connectors/jira/JiraConnector.js";
import { GoogleDriveConnector } from "./connectors/googledrive/GoogleDriveConnector.js";
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
    case "sharepoint":
      return Promise.resolve(SharePointConnector.fromEnv());
    case "salesforce":
      return Promise.resolve(SalesforceConnector.fromEnv());
    case "jira":
      return Promise.resolve(JiraConnector.fromEnv());
    case "googledrive":
    case "google-drive":
    case "gdrive":
      return Promise.resolve(GoogleDriveConnector.fromEnv());
    default:
      throw new Error(
        `Unknown connector: ${name}. Use slack, postgres, sharepoint, salesforce, jira, or googledrive.`
      );
  }
}

function defaultObjects(connectorKey) {
  if (connectorKey === "postgres") {
    return ["schemas", "tables", "views", "columns"];
  }
  if (connectorKey === "sharepoint") {
    return ["sites", "lists", "columns", "listItems", "drives", "driveItems"];
  }
  if (connectorKey === "salesforce") {
    return ["sobjects", "fields", "records"];
  }
  if (connectorKey === "jira") {
    return ["projects", "issues", "users", "statuses", "issueTypes"];
  }
  if (
    connectorKey === "googledrive" ||
    connectorKey === "google-drive" ||
    connectorKey === "gdrive"
  ) {
    return ["drives", "files", "folders", "permissions"];
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

  npm run test:connection -- --connector slack|postgres|sharepoint|salesforce|jira|googledrive
  npm run extract -- --connector googledrive
  npm run extract -- --connector googledrive --objects drives,files,folders
  npm run extract:slack | extract:postgres | extract:sharepoint | extract:salesforce | extract:jira | extract:googledrive

Slack:
  SLACK_BOT_TOKEN

Postgres:
  POSTGRES_URL or HOST/DATABASE/USER/PASSWORD

SharePoint:
  SHAREPOINT_TENANT_ID, CLIENT_ID, CLIENT_SECRET, HOSTNAME, SITE_PATH

Salesforce:
  SF_ACCESS_TOKEN + SF_INSTANCE_URL  (or client id/secret + password)

Jira Cloud:
  JIRA_BASE_URL=https://your-domain.atlassian.net
  JIRA_EMAIL=you@company.com
  JIRA_API_TOKEN=...
  Optional: JIRA_JQL=project = ABC ORDER BY updated DESC
  Optional: JIRA_MAX_ISSUES=500

Google Drive:
  GOOGLE_SERVICE_ACCOUNT_FILE=./certs/google-sa.json
  Or: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
  Or: GOOGLE_ACCESS_TOKEN
  Optional: GOOGLE_IMPERSONATE_USER, GOOGLE_DRIVE_MAX_FILES, GOOGLE_DRIVE_QUERY
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
