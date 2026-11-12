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
import loggerFactory from "./logger.js";

const logger = loggerFactory.component("CLI");
const LOGIN_OPTIONS = new Set(["--user", "--username", "--password", "--pass"]);

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    connector: "slack",
    objects: null,
    mode: "full",
    projectKey: null,
    jql: null,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const option = argv[i];

    if (option === "--connector") {
      args.connector = readOptionValue(argv, i).trim().toLowerCase();
      i += 1;
    } else if (option === "--objects") {
      args.objects = readOptionValue(argv, i).split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (option === "--mode") {
      args.mode = readOptionValue(argv, i).trim().toLowerCase();
      i += 1;
    } else if (option === "--project-key") {
      args.projectKey = readOptionValue(argv, i).trim();
      i += 1;
    } else if (option === "--jql") {
      args.jql = readOptionValue(argv, i).trim();
      if (!args.jql) {
        throw new Error("--jql requires a non-empty query");
      }
      i += 1;
    } else if (args.command === "login" && LOGIN_OPTIONS.has(option)) {
      readOptionValue(argv, i);
      i += 1;
    } else if (option.startsWith("-")) {
      throw new Error(`Unknown option "${option}"`);
    } else {
      throw new Error(
        'Unexpected command-line argument. When passing options through npm, add "--" before the options. ' +
          "Example: npm run <script> -- --option value"
      );
    }
  }

  return args;
}

function readOptionValue(argv, optionIndex) {
  const option = argv[optionIndex];
  const value = argv[optionIndex + 1];

  if (value == null || value === "" || value.startsWith("--")) {
    throw new Error(`Option "${option}" requires a value`);
  }

  return value;
}

function validateJqlOptions(args, objects = args.objects) {
  if (args.jql === null) return;

  if (args.connector !== "jira") {
    throw new Error("--jql can only be used with the Jira connector");
  }
  if (args.command !== "extract" && args.command !== "extract-mongo") {
    throw new Error("--jql is supported only for extract and extract-mongo");
  }
  if (args.mode !== "full" && args.mode !== "incremental") {
    throw new Error("Jira extraction mode must be full or incremental");
  }
  if (objects && (objects.length !== 1 || objects[0] !== "issues")) {
    throw new Error("--jql requires issues to be the only selected Jira object");
  }
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

function createConnector(name, options = {}) {
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
      return Promise.resolve(JiraConnector.fromEnv({
        projectKey: options.projectKey,
        jql: options.jql,
      }));
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
  validateJqlOptions(args);

  if (args.projectKey && args.connector !== "jira") {
    throw new Error("--project-key can only be used with the Jira connector");
  }

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

  const connector = await createConnector(args.connector, {
    projectKey: args.projectKey,
    jql: args.jql,
  });

  if (args.jql !== null) {
    validateJqlOptions(args, args.objects || connector.getObjects());
    const prepared = await connector.prepareCustomJql();
    connector.validateExtractionMode(args.mode);
    if (prepared.checkpointPolicy === "skip") {
      console.log(`[jira] checkpoint skipped: ${prepared.checkpointReason}`);
    }
  }

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
  Optional project filter: --project-key DCS
  Fallback project filter: JIRA_PROJECT_KEY, then options.projectKey in jira.json
  Extraction settings: src/config/connectors/jira.json
  Automatic projects: no --project-key, no project fallback, and no --jql.
  Default full extraction (all enabled objects):
    npm run extract:jira:mongo
  Issues only (discovers projects without saving project records):
    npm run extract:jira:mongo -- --objects issues
  Incremental issues after a successful all-project full run:
    npm run extract:jira:mongo:incremental
  All-project checkpoint scope: all-projects; state stores covered project IDs and keys.
  Existing project IDs use the incremental window and lookback; new IDs get a full baseline.
  Project key renames keep the baseline by ID. Missing projects are recorded, not deleted.
  A missing project that reappears gets a full baseline after a successful run omitted it.
  Empty incremental discovery after a non-empty baseline stops the run.
  Project-specific/custom-JQL checkpoints cannot initialize all-project extraction.
  Old or invalid all-project state requires full extraction again; records are not cleared.
  A filtered defaultJql with automatic discovery is full-only; use --jql for filtered extraction.
  History: extractionConfig.issues.queryMode = per-project, with project queries and results.
  Project results describe source traversal, not guaranteed committed MongoDB writes.
  Jira does not mark missing records as deleted, in full or incremental mode.
  File output (separate full baseline and checkpoint required):
    npm run extract:jira -- --objects issues
    npm run extract:jira -- --objects issues --mode incremental
  Custom query: --jql 'issuetype = Bug ORDER BY priority DESC'
  --jql is only for extract/extract-mongo with issues as the only selected object.
  Keep the npm separator -- and quote the complete query (examples use PowerShell).
  Full MongoDB:
    npm run extract:jira:mongo -- --objects issues --project-key DCPT --jql 'issuetype = Bug ORDER BY priority DESC'
  Incremental MongoDB (issues is already selected by the script):
    npm run extract:jira:mongo:incremental -- --project-key DCPT --jql 'issuetype = Bug ORDER BY priority DESC'
  Historical full extraction (no checkpoint writes):
    npm run extract:jira:mongo -- --objects issues --project-key DCPT --jql "updated >= '2026-10-01' AND updated < '2026-10-10'"
  Status query (PowerShell: double quotes outside, single quotes inside):
    npm run extract:jira:mongo -- --objects issues --project-key DCPT --jql "issuetype = Bug AND status = 'In Progress'"
  File output:
    npm run extract:jira -- --objects issues --project-key DCPT --jql 'issuetype = Bug'
  Jira validates the supplied and combined query; errors and warnings stop extraction.
  Specify project conditions in --project-key or --jql, not both (even for the same project).
  A project condition in --jql ignores the fallback project in .env and jira.json.
  Otherwise the resolved project is added; configured default filters still apply.
  User ordering is preserved. Custom JQL is limited to 10000 characters.
  Each effective filter has its own checkpoint; run full first for that destination.
  Ordering does not change the scope; changing filter text may require another full run.
  A fixed created range can track later updates to those issues.
  updated/updatedDate filters and queries with functions are full-only; checkpoints are skipped.
  Saved-filter references are unsupported; supply the full JQL conditions.
  Custom JQL does not detect issues leaving the filter.
  Only one Jira MongoDB extraction can run at a time per runtime database.
  Project/issue or batch-write failures before checkpoint saving keep prior progress; partial writes remain.
  A final audit failure after checkpoint saving can leave the checkpoint advanced.
  Old issues newly visible inside a known project still need periodic full refreshes.
  Full instructions and limitations: README.md, Jira Connector section.

Google Drive:
  OAuth 2.0 only: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
  Run npm run auth:googledrive once on the host to save a refresh token.
  Optional: GOOGLE_DRIVE_MAX_FILES, GOOGLE_DRIVE_QUERY

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
  logger.trackError(err);
  process.exitCode = 1;
});
