import { Router } from "express";
import { requireDatabase, sendError } from "../middleware.js";
import {
  createConnection,
  ensureConnectionsIndexes,
  jiraObjectNames,
  oracleObjectNames,
  slackObjectNames,
  supportedConnectors,
  toPublicConnection,
} from "./connectionsService.js";

function canConfigureConnections(session) {
  if (!session) return false;
  if (session.role === "admin") return true;
  const permissions = Array.isArray(session.permissions) ? session.permissions : [];
  return permissions.includes("connectors.configure");
}

export function createConnectionsRouter(database) {
  const router = Router();
  let indexesReady = null;

  async function ready(databaseHandle) {
    if (!indexesReady) {
      indexesReady = ensureConnectionsIndexes(databaseHandle).catch((error) => {
        indexesReady = null;
        throw error;
      });
    }
    await indexesReady;
  }

  router.get("/meta", (req, res) => {
    const session = res.locals.session;
    return res.status(200).json({
      data: {
        connectors: supportedConnectors(),
        jira: {
          authTypes: ["api_token"],
          objects: jiraObjectNames(),
          fields: {
            userId: "Frontend / app user id that owns this connection",
            name: "Connection display name",
            baseUrl: "https://your-team.atlassian.net",
            email: "Atlassian account email",
            apiToken: "Atlassian API token (write-only)",
            objects: "Subset of Jira objects to extract",
          },
        },
        slack: {
          authTypes: ["bot_token"],
          objects: slackObjectNames(),
          fields: {
            userId: "Frontend / app user id that owns this connection",
            name: "Connection display name",
            workspaceUrl: "Optional https://your-workspace.slack.com",
            account: "Optional account/team label for display",
            botToken: "Slack bot token xoxb-… (write-only)",
            userToken: "Optional Slack user token xoxp-… (write-only)",
            objects: "Subset of Slack objects to extract",
            channelIds: "Optional channel id list (C…/G…)",
            historyDays: "Optional message lookback in days",
          },
        },
        oracle: {
          authTypes: ["database_credentials"],
          objects: oracleObjectNames(),
          fields: {
            userId: "Frontend / app user id that owns this connection",
            name: "Connection display name",
            username: "Oracle DB username",
            password: "Oracle DB password (write-only)",
            connectString: "host:port/service or full connect descriptor",
            host: "Optional when connectString omitted",
            port: "Optional Oracle port (default 1521)",
            serviceName: "Optional service name with host",
            sid: "Optional SID with host",
            objects: "Subset of Oracle objects to extract",
            schemas: "Optional schema allow-list",
            schemaName: "Optional schema for table_data",
            tableName: "Optional single table for table_data",
            tablesSpec: "Optional comma-separated tables for table_data",
            pageSize: "Optional row page size",
            modifiedColumn: "Optional incremental modified column",
          },
        },
        canConfigure: canConfigureConnections(session),
      },
      requestId: res.locals.requestId,
    });
  });

  router.post("/", requireDatabase(database), async (req, res, next) => {
    try {
      if (!canConfigureConnections(res.locals.session)) {
        return sendError(
          res,
          403,
          "FORBIDDEN",
          "You do not have permission to register connections."
        );
      }

      await ready(database);
      const record = await createConnection(database, req.body, {
        createdBy: res.locals.session?.username || null,
      });

      return res.status(201).json({
        data: toPublicConnection(record),
        requestId: res.locals.requestId,
      });
    } catch (error) {
      if (error.status && error.code) {
        return sendError(res, error.status, error.code, error.message);
      }
      return next(error);
    }
  });

  return router;
}
