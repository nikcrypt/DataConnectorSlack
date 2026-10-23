import { SlackConnector } from "../connectors/slack/SlackConnector.js";
import { PostgresConnector } from "../connectors/postgres/PostgresConnector.js";
import { SharePointConnector } from "../connectors/sharepoint/SharePointConnector.js";
import { SalesforceConnector } from "../connectors/salesforce/SalesforceConnector.js";
import { JiraConnector } from "../connectors/jira/JiraConnector.js";
import { GoogleDriveConnector } from "../connectors/googledrive/GoogleDriveConnector.js";
import { BoxConnector } from "../connectors/box/BoxConnector.js";
import { ConfluenceConnector } from "../connectors/confluence/ConfluenceConnector.js";
import { OracleConnector } from "../connectors/oracle/OracleConnector.js";
import { MysqlConnector } from "../connectors/mysql/MysqlConnector.js";
import { MSSQLConnector } from "../connectors/mssql/MSSQLConnector.js";
import { WindowsConnector } from "../connectors/windows/WindowsConnector.js";
import { ServiceNowConnector } from "../connectors/servicenow/ServiceNowConnector.js";
import { loadSlackAuth, getBotTokenFromEnvOrAuth } from "../connectors/slack/tokenStore.js";

async function loadSlackConfig() {
  const auth = await loadSlackAuth();
  const botToken = getBotTokenFromEnvOrAuth(auth);
  if (!botToken) {
    throw new Error("Missing SLACK_BOT_TOKEN. Set it in .env or run: npm run auth");
  }
  const userToken = process.env.SLACK_USER_TOKEN?.startsWith("xoxp-")
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

export async function createConnector(name) {
  const key = String(name || "").trim().toLowerCase();
  switch (key) {
    case "slack":
      return new SlackConnector(await loadSlackConfig());
    case "postgres":
      return PostgresConnector.fromEnv();
    case "sharepoint":
      return SharePointConnector.fromEnv();
    case "onedrive": {
      // Lazy load — other-dev Graph client may still be incomplete
      const { OneDriveConnector } = await import(
        "../connectors/onedrive/OneDriveConnector.js"
      );
      return OneDriveConnector.fromEnv();
    }
    case "salesforce":
      return SalesforceConnector.fromEnv();
    case "jira":
      return JiraConnector.fromEnv();
    case "googledrive":
    case "google-drive":
    case "gdrive":
      return GoogleDriveConnector.fromEnv();
    case "box":
      return BoxConnector.fromEnv();
    case "confluence":
      return ConfluenceConnector.fromEnv();
    case "oracle":
      return OracleConnector.fromEnv();
    case "mysql":
      return MysqlConnector.fromEnv();
    case "mssql":
    case "sqlserver":
      return MSSQLConnector.fromEnv();
    case "windows":
    case "windowsfs":
      return WindowsConnector.fromEnv();
    case "servicenow":
    case "service-now":
      return ServiceNowConnector.fromEnv();
    default:
      throw Object.assign(
        new Error(`Unknown connector: ${name}`),
        { status: 400 }
      );
  }
}
