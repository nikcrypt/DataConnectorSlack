import { Router } from "express";
import { requireDatabase, sendError } from "../middleware.js";
import {
  createConnection,
  ensureConnectionsIndexes,
  jiraObjectNames,
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
