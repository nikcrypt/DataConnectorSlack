import "dotenv/config";
import { SlackConnector } from "./connectors/slack/SlackConnector.js";
import { PostgresConnector } from "./connectors/postgres/PostgresConnector.js";
import { SharePointConnector } from "./connectors/sharepoint/SharePointConnector.js";
import { SalesforceConnector } from "./connectors/salesforce/SalesforceConnector.js";
import { JiraConnector } from "./connectors/jira/JiraConnector.js";
import { GoogleDriveConnector } from "./connectors/googledrive/GoogleDriveConnector.js";
import { BoxConnector } from "./connectors/box/BoxConnector.js";
import { ConfluenceConnector } from "./connectors/confluence/ConfluenceConnector.js";
import { OracleConnector } from "./connectors/oracle/OracleConnector.js";
import { MysqlConnector } from "./connectors/mysql/MysqlConnector.js";
import { MSSQLConnector } from "./connectors/mssql/MSSQLConnector.js";
import { WindowsConnector } from "./connectors/windows/WindowsConnector.js";
import { ServiceNowConnector } from "./connectors/servicenow/ServiceNowConnector.js";
import { ConnectorRuntimeEngine } from "./runtime/ConnectorRuntimeEngine.js";
import { MongoRuntime } from "./runtime/MongoRuntime.js";
import { loadSlackAuth, getBotTokenFromEnvOrAuth } from "./connectors/slack/tokenStore.js";
import { loginCli, logoutCli, requireCliAuth } from "./cliAuth.js";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    connector: "slack",
    objects: null,
    mode: "full",
  };

  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--connector" && argv[i + 1]) {
      args.connector = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (argv[i] === "--objects" && argv[i + 1]) {
      args.objects = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (argv[i] === "--mode" && argv[i + 1]) {
      args.mode = argv[i + 1].trim().toLowerCase();
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
    case "onedrive":
      // Lazy-load so a missing OneDrive Graph dependency does not break other connectors
      return import("./connectors/onedrive/OneDriveConnector.js").then(({ OneDriveConnector }) =>
        OneDriveConnector.fromEnv()
      );
    case "salesforce":
      return Promise.resolve(SalesforceConnector.fromEnv());
    case "jira":
      return Promise.resolve(JiraConnector.fromEnv());
    case "googledrive":
    case "google-drive":
    case "gdrive":
      return Promise.resolve(GoogleDriveConnector.fromEnv());
    case "box":
      return Promise.resolve(BoxConnector.fromEnv());
    case "confluence":
      return Promise.resolve(ConfluenceConnector.fromEnv());
    case "oracle":
      return Promise.resolve(OracleConnector.fromEnv());
    case "mysql":
      return Promise.resolve(MysqlConnector.fromEnv());
    case "mssql":
    case "sqlserver":
      return Promise.resolve(MSSQLConnector.fromEnv());
    case "windows":
    case "windowsfs":
      return Promise.resolve(WindowsConnector.fromEnv());
    case "servicenow":
    case "service-now":
      return Promise.resolve(ServiceNowConnector.fromEnv());
    default:
      throw new Error(
        `Unknown connector: ${name}. Use slack, postgres, mysql, mssql, sharepoint, onedrive, salesforce, jira, googledrive, box, confluence, oracle, windows, or servicenow.`
      );
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }

  if (args.command === "login") {
    const session = await loginCli(process.argv);
    console.log(`[cli] logged in as ${session.user} (expires ${session.expiresAt}, ${session.hours}h)`);
    return;
  }

  if (args.command === "logout") {
    const cleared = await logoutCli();
    console.log(cleared ? "[cli] logged out" : "[cli] no active session");
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

  const session = await requireCliAuth();
  console.log(`[cli] session ok (${session.user})`);

  const connector = await createConnector(args.connector);

  if (args.command === "test") {
    const result = await connector.testConnection();
    console.log("Connection OK:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "extract") {
    const runtime = new ConnectorRuntimeEngine(connector);
    const objects = args.objects || connector.getObjects();
    const known = new Set(connector.getObjects());
    const unknown = objects.filter((object) => !known.has(object));
    if (unknown.length) {
      throw new Error(
        `Unknown ${connector.getConnectorKey()} object: ${unknown.join(", ")}. ` +
          `Valid objects: ${connector.getObjects().join(", ")}`
      );
    }
    console.log(
      `[runtime] ${connector.getConnectorKey()} objects: ${objects.join(", ")}`
    );
    await runtime.run({ objects, mode: args.mode || "full" });
    return;
  }

  if (args.command === "extract-mongo") {
    const objects = args.objects || connector.getObjects();
    const known = new Set(connector.getObjects());
    const unknown = objects.filter((object) => !known.has(object));
    if (unknown.length) {
      throw new Error(
        `Unknown ${args.connector} object: ${unknown.join(", ")}. Valid objects: ${connector.getObjects().join(", ")}`
      );
    }
    console.log(`[mongo] ${args.connector} objects: ${objects.join(", ")}`);
    const runtime = new MongoRuntime(connector);
    const summary = await runtime.run({ objects, mode: args.mode || "full" });
    console.log(`[mongo] run ${summary.runId} ${summary.status} -> ${summary.database}.${summary.collection}`);
    return;
  }

  console.error(`Unknown command: ${args.command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp() {
  console.log(`
Data connector CLI

  CLI auth (login once, then run connectors):
    Set APP_AUTH_USER and APP_AUTH_PASSWORD in .env
    npm run login -- --user qa --password secret
    npm run test:jira
    npm run extract:jira:mongo
    npm run logout
    Optional: APP_AUTH_SESSION_HOURS=12 (default 12)

  npm run test:connection -- --connector slack|postgres|mysql|mssql|oracle|sharepoint|onedrive|salesforce|jira|googledrive|box|confluence|windows|servicenow
  npm run extract -- --connector mysql
  npm run extract -- --connector mysql --objects schemas,tables,columns
  npm run extract:slack | extract:postgres | extract:mysql | extract:mssql | extract:oracle | extract:sharepoint | extract:onedrive | extract:salesforce | extract:jira | extract:googledrive | extract:box | extract:confluence | extract:windows | extract:servicenow
  npm run extract:slack:mongo | extract:postgres:mongo | extract:mysql:mongo | extract:mssql:mongo | extract:oracle:mongo | extract:sharepoint:mongo | extract:onedrive:mongo | extract:salesforce:mongo | extract:jira:mongo | extract:googledrive:mongo | extract:box:mongo | extract:confluence:mongo | extract:windows:mongo | extract:servicenow:mongo
  npm run extract:slack:mongo:incremental
  npm run extract:mssql:mongo:incremental
  npm run extract:oracle:mongo:incremental
  npm run extract:mysql:mongo:incremental
  npm run extract:postgres:mongo:incremental
  npm run extract:onedrive:mongo:incremental
  npm run extract:servicenow:mongo:incremental

Slack:
  SLACK_BOT_TOKEN
  MONGO_URL   (every extract:<name>:mongo command)

Postgres:
  POSTGRES_URL or HOST/DATABASE/USER/PASSWORD
  Optional: POSTGRES_SCHEMAS
  Incremental view changes need track_commit_timestamp=on on the server

ServiceNow:
  SERVICENOW_BASE_URL
  SERVICENOW_USERNAME + SERVICENOW_PASSWORD
  Or: SERVICENOW_AUTH_TYPE=bearer and SERVICENOW_ACCESS_TOKEN
  Optional: SERVICENOW_PAGE_SIZE, SERVICENOW_CUSTOM_FIELD_MODE

MySQL:
  MYSQL_URL or HOST/USER/PASSWORD
  Optional: MYSQL_DATABASE, MYSQL_PORT, MYSQL_SSL, MYSQL_SCHEMAS

SQL Server:
  MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD, MSSQL_DATABASE
  Optional: MSSQL_PORT, MSSQL_SCHEMAS, MSSQL_SCHEMA, MSSQL_TABLE, MSSQL_PAGE_SIZE, MSSQL_MODIFIED_COLUMN

Oracle:
  ORACLE_USER + ORACLE_PASSWORD + ORACLE_CONNECT_STRING
  Or: ORACLE_HOST + ORACLE_SERVICE_NAME (or ORACLE_SID)
  Optional: ORACLE_SCHEMAS=HR,APP

SharePoint:
  SHAREPOINT_TENANT_ID, CLIENT_ID, CLIENT_SECRET, HOSTNAME, SITE_PATH

OneDrive:
  ONEDRIVE_TENANT_ID, ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET
  ONEDRIVE_USER_ID=user@company.com
  Objects: drives, driveItems
  Extraction settings: src/config/connectors/onedrive.json

Salesforce:
  SF_ACCESS_TOKEN + SF_INSTANCE_URL  (or client id/secret + password)

Jira Cloud:
  JIRA_BASE_URL=https://your-domain.atlassian.net
  JIRA_EMAIL=you@company.com
  JIRA_API_TOKEN=...
  Optional: JIRA_JQL=updated >= -365d ORDER BY updated DESC
  Optional: JIRA_MAX_ISSUES=500

Google Drive:
  GOOGLE_SERVICE_ACCOUNT_FILE=./certs/google-sa.json
  Or: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
  Or: GOOGLE_ACCESS_TOKEN
  Optional: GOOGLE_IMPERSONATE_USER, GOOGLE_DRIVE_MAX_FILES, GOOGLE_DRIVE_QUERY

Box:
  BOX_ACCESS_TOKEN  (developer token POC)
  Or: BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID  (CCG)
  Or: BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN
  Optional: BOX_ROOT_FOLDER_ID=0, BOX_MAX_DEPTH, BOX_MAX_ITEMS

Confluence Cloud:
  CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
  CONFLUENCE_EMAIL=you@company.com
  CONFLUENCE_API_TOKEN=...
  Falls back to JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN on the same site
  Optional: CONFLUENCE_MAX_PAGES, CONFLUENCE_MAX_BLOGPOSTS

Windows folder:
  WINDOWS_FOLDER_URL=smb://host/share/folder
  Or: file:///path/to/mounted/folder
  Optional: WINDOWS_USERNAME, WINDOWS_PASSWORD, WINDOWS_DOMAIN
  Optional: WINDOWS_MAX_DEPTH, WINDOWS_MAX_FILES, WINDOWS_MAX_DOWNLOAD_BYTES
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
