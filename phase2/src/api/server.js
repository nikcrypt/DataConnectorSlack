import http from "node:http";
import { env, kafkaConfig } from "../shared/config.js";
import { closePool, getPool } from "../shared/db.js";
import { createKafka, publishJson } from "../shared/kafka.js";
import { assertCommand } from "../shared/validate.js";

const port = Number(env("API_PORT", "8080"));
const { cfg, kafka } = createKafka("api");
const producer = kafka.producer();

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function createExtraction(body) {
  const connectorKey = String(body.connector_key || "").trim().toLowerCase();
  if (!connectorKey) throw Object.assign(new Error("connector_key is required"), { status: 400 });

  const objects = Array.isArray(body.objects)
    ? body.objects.map((o) => String(o).trim()).filter(Boolean)
    : [];
  const mode = body.mode === "incremental" ? "incremental" : "full";
  const tenantId = String(body.tenant_id || "default");
  const requestedBy = body.requested_by ? String(body.requested_by) : null;
  const params = body.params && typeof body.params === "object" ? body.params : {};

  const pool = getPool();
  const connector = await pool.query(
    "SELECT key FROM connectors WHERE key = $1 AND enabled = TRUE",
    [connectorKey]
  );
  if (!connector.rowCount) {
    throw Object.assign(new Error(`Unknown or disabled connector: ${connectorKey}`), {
      status: 400,
    });
  }

  const inserted = await pool.query(
    `INSERT INTO extraction_requests
      (tenant_id, connector_key, objects, params, mode, requested_by, status)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 'queued')
     RETURNING *`,
    [
      tenantId,
      connectorKey,
      JSON.stringify(objects),
      JSON.stringify(params),
      mode,
      requestedBy,
    ]
  );
  const request = inserted.rows[0];

  for (const object of objects) {
    await pool.query(
      `INSERT INTO extraction_objects (request_id, object, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT DO NOTHING`,
      [request.id, object]
    );
  }

  const command = assertCommand({
    request_id: request.id,
    connector_key: connectorKey,
    objects,
    mode,
    tenant_id: tenantId,
    requested_at: new Date(request.created_at).toISOString(),
  });

  await publishJson(producer, cfg.commandsTopic, connectorKey, command);

  return {
    request_id: request.id,
    status: request.status,
    connector_key: request.connector_key,
    mode: request.mode,
    objects: request.objects,
  };
}

async function getExtraction(id) {
  const pool = getPool();
  const request = await pool.query("SELECT * FROM extraction_requests WHERE id = $1", [id]);
  if (!request.rowCount) {
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
  const objects = await pool.query(
    "SELECT object, status, records_written, checkpoint, updated_at FROM extraction_objects WHERE request_id = $1 ORDER BY object",
    [id]
  );
  const artifacts = await pool.query(
    "SELECT object, uri, bytes, record_count, content_hash, created_at FROM output_artifacts WHERE request_id = $1 ORDER BY created_at",
    [id]
  );
  const runs = await pool.query(
    "SELECT id, attempt, worker_id, started_at, finished_at, error FROM extraction_runs WHERE request_id = $1 ORDER BY attempt",
    [id]
  );
  return {
    ...request.rows[0],
    objects: objects.rows,
    artifacts: artifacts.rows,
    runs: runs.rows,
  };
}

async function listExtractions(url) {
  const tenantId = url.searchParams.get("tenant_id") || "default";
  const status = url.searchParams.get("status");
  const connectorKey = url.searchParams.get("connector_key");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const clauses = ["tenant_id = $1"];
  const values = [tenantId];
  if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  if (connectorKey) {
    values.push(connectorKey);
    clauses.push(`connector_key = $${values.length}`);
  }
  values.push(limit);

  const result = await getPool().query(
    `SELECT id, tenant_id, connector_key, objects, mode, status, requested_by, error_message, created_at, updated_at
     FROM extraction_requests
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return { items: result.rows };
}

async function cancelExtraction(id) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE extraction_requests
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING id, status`,
    [id]
  );
  if (!result.rowCount) {
    const existing = await pool.query("SELECT id, status FROM extraction_requests WHERE id = $1", [
      id,
    ]);
    if (!existing.rowCount) {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    return { request_id: id, status: existing.rows[0].status, cancelled: false };
  }
  return { request_id: id, status: "cancelled", cancelled: true };
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "api" });
    }

    if (req.method === "POST" && url.pathname === "/extractions") {
      const body = await readJson(req);
      const created = await createExtraction(body);
      return send(res, 202, created);
    }

    if (req.method === "GET" && url.pathname === "/extractions") {
      return send(res, 200, await listExtractions(url));
    }

    const matchGet = url.pathname.match(/^\/extractions\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && matchGet) {
      return send(res, 200, await getExtraction(matchGet[1]));
    }

    const matchCancel = url.pathname.match(/^\/extractions\/([0-9a-f-]{36})\/cancel$/i);
    if (req.method === "POST" && matchCancel) {
      return send(res, 200, await cancelExtraction(matchCancel[1]));
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : 500);
    console.error("[api]", error.message);
    return send(res, status, { error: error.message });
  }
}

async function main() {
  await producer.connect();
  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.listen(port, () => {
    console.log(`[api] listening on :${port}`);
    console.log(`[api] kafka brokers ${kafkaConfig().brokers.join(",")}`);
  });

  const shutdown = async () => {
    server.close();
    await producer.disconnect().catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[api] fatal", error);
  process.exit(1);
});
