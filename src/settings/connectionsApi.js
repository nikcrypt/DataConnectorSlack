import { appendAudit } from "./audit.js";
import {
  createConnection,
  deleteConnection,
  getConnection,
  jiraObjectNames,
  listConnections,
  markConnectionTest,
  supportedConnectionConnectors,
  toPublicConnection,
  updateConnection,
} from "./connectionsStore.js";
import { createConnectorFromConnection } from "./createConnectorFromConnection.js";
import { canEdit, canRunExtract } from "./rbac.js";
import { startExtractJob } from "./runExtract.js";

/**
 * Handle /api/connections* routes.
 * @returns {Promise<boolean>} true if the request was handled
 */
export async function handleConnectionsApi(req, res, url, {
  requireAuth,
  sendJson,
  readJson,
}) {
  if (req.method === "GET" && url.pathname === "/api/connections/meta") {
    const session = await requireAuth(req, res);
    if (!session) return true;
    return done(sendJson, res, 200, {
      connectors: supportedConnectionConnectors(),
      jira: {
        authTypes: ["api_token"],
        objects: jiraObjectNames(),
        fields: {
          name: "Connection display name",
          baseUrl: "https://your-team.atlassian.net",
          email: "Atlassian account email",
          apiToken: "Atlassian API token (write-only)",
          objects: "Subset of Jira objects to extract",
        },
      },
      canEdit: canEdit(session.role),
      canRunExtract: canRunExtract(session.role),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/connections") {
    const session = await requireAuth(req, res);
    if (!session) return true;
    const connector = url.searchParams.get("connector") || undefined;
    const items = await listConnections({ connector });
    return done(sendJson, res, 200, {
      connections: items.map(toPublicConnection),
      canEdit: canEdit(session.role),
      canRunExtract: canRunExtract(session.role),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/connections") {
    const session = await requireAuth(req, res, { edit: true });
    if (!session) return true;
    try {
      const body = await readJson(req);
      const record = await createConnection(body, { createdBy: session.username });
      await appendAudit({
        action: "connection_create",
        username: session.username,
        role: session.role,
        connector: record.connector,
        connectionId: record.id,
      });
      return done(sendJson, res, 201, toPublicConnection(record));
    } catch (error) {
      return done(sendJson, res, error.status || 400, { error: error.message });
    }
  }

  const one = url.pathname.match(
    /^\/api\/connections\/([0-9a-f-]{36})$/i
  );
  if (one && req.method === "GET") {
    const session = await requireAuth(req, res);
    if (!session) return true;
    try {
      const record = await getConnection(one[1]);
      return done(sendJson, res, 200, toPublicConnection(record));
    } catch (error) {
      return done(sendJson, res, error.status || 500, { error: error.message });
    }
  }

  if (one && req.method === "PATCH") {
    const session = await requireAuth(req, res, { edit: true });
    if (!session) return true;
    try {
      const body = await readJson(req);
      const record = await updateConnection(one[1], body);
      await appendAudit({
        action: "connection_update",
        username: session.username,
        role: session.role,
        connector: record.connector,
        connectionId: record.id,
      });
      return done(sendJson, res, 200, toPublicConnection(record));
    } catch (error) {
      return done(sendJson, res, error.status || 500, { error: error.message });
    }
  }

  if (one && req.method === "DELETE") {
    const session = await requireAuth(req, res, { edit: true });
    if (!session) return true;
    try {
      const existing = await getConnection(one[1]);
      await deleteConnection(one[1]);
      await appendAudit({
        action: "connection_delete",
        username: session.username,
        role: session.role,
        connector: existing.connector,
        connectionId: existing.id,
      });
      return done(sendJson, res, 200, { ok: true, id: existing.id });
    } catch (error) {
      return done(sendJson, res, error.status || 500, { error: error.message });
    }
  }

  const testMatch = url.pathname.match(
    /^\/api\/connections\/([0-9a-f-]{36})\/test$/i
  );
  if (testMatch && req.method === "POST") {
    const session = await requireAuth(req, res, { edit: true });
    if (!session) return true;
    try {
      const connector = await createConnectorFromConnection(testMatch[1]);
      const result = await connector.testConnection();
      await markConnectionTest(testMatch[1], { ok: true });
      await appendAudit({
        action: "connection_test",
        username: session.username,
        role: session.role,
        connectionId: testMatch[1],
        ok: true,
      });
      return done(sendJson, res, 200, { ok: true, result });
    } catch (error) {
      await markConnectionTest(testMatch[1], { ok: false, error: error.message }).catch(() => {});
      await appendAudit({
        action: "connection_test_failed",
        username: session.username,
        role: session.role,
        connectionId: testMatch[1],
        error: error.message,
      }).catch(() => {});
      return done(sendJson, res, error.status || 502, {
        ok: false,
        error: error.message,
      });
    }
  }

  const extractMatch = url.pathname.match(
    /^\/api\/connections\/([0-9a-f-]{36})\/extract$/i
  );
  if (extractMatch && req.method === "POST") {
    const session = await requireAuth(req, res, { run: true });
    if (!session) return true;
    try {
      const connection = await getConnection(extractMatch[1]);
      const body = await readJson(req);
      const objects = Array.isArray(body.objects)
        ? body.objects.map((item) => String(item).trim()).filter(Boolean)
        : (connection.objects || []);
      const mode = body.mode === "incremental" ? "incremental" : "full";
      const target = body.target === "jsonl" ? "jsonl" : "mongo";
      const created = startExtractJob({
        connectorKey: connection.connector,
        connectionId: connection.id,
        objects,
        mode,
        target,
        requestedBy: session.username,
      });
      await appendAudit({
        action: "connection_extract",
        username: session.username,
        role: session.role,
        connector: connection.connector,
        connectionId: connection.id,
        mode,
        target,
        objects,
        requestId: created.request_id,
      });
      return done(sendJson, res, 202, created);
    } catch (error) {
      await appendAudit({
        action: "connection_extract_failed",
        username: session.username,
        role: session.role,
        connectionId: extractMatch[1],
        error: error.message,
      }).catch(() => {});
      return done(sendJson, res, error.status || 500, { error: error.message });
    }
  }

  return false;
}

function done(sendJson, res, status, body) {
  sendJson(res, status, body);
  return true;
}
