import { kafkaConfig } from "../shared/config.js";
import { closePool, getPool } from "../shared/db.js";
import { createKafka } from "../shared/kafka.js";
import { assertEvent } from "../shared/validate.js";

const { cfg, kafka } = createKafka("status-writer");
const consumer = kafka.consumer({ groupId: "status-writer" });

async function applyEvent(event) {
  const pool = getPool();
  const at = new Date(event.at);

  if (event.event === "started") {
    await pool.query(
      `UPDATE extraction_requests
       SET status = 'running', updated_at = $2, error_message = NULL
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [event.request_id, at]
    );
    const attempt = event.attempt || 1;
    await pool.query(
      `INSERT INTO extraction_runs (id, request_id, attempt, worker_id, started_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
       ON CONFLICT (request_id, attempt) DO UPDATE
         SET worker_id = EXCLUDED.worker_id,
             started_at = COALESCE(extraction_runs.started_at, EXCLUDED.started_at)`,
      [event.run_id || null, event.request_id, attempt, event.worker_id || null, at]
    );
    return;
  }

  if (event.event === "progress") {
    if (!event.object) return;
    await pool.query(
      `INSERT INTO extraction_objects (request_id, object, status, records_written, updated_at)
       VALUES ($1, $2, 'running', $3, $4)
       ON CONFLICT (request_id, object) DO UPDATE
         SET status = 'running',
             records_written = EXCLUDED.records_written,
             updated_at = EXCLUDED.updated_at`,
      [event.request_id, event.object, event.records_written || 0, at]
    );
    return;
  }

  if (event.event === "completed") {
    await pool.query(
      `UPDATE extraction_requests
       SET status = 'succeeded', updated_at = $2, error_message = NULL
       WHERE id = $1 AND status <> 'cancelled'`,
      [event.request_id, at]
    );
    if (event.run_id || event.attempt) {
      await pool.query(
        `UPDATE extraction_runs
         SET finished_at = $3, error = NULL
         WHERE request_id = $1 AND ($2::uuid IS NULL OR id = $2)
           AND ($4::int IS NULL OR attempt = $4)`,
        [event.request_id, event.run_id || null, at, event.attempt || null]
      );
    }
    for (const artifact of event.artifacts || []) {
      await pool.query(
        `INSERT INTO output_artifacts (request_id, object, uri, bytes, record_count, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (request_id, object, uri) DO UPDATE
           SET bytes = EXCLUDED.bytes,
               record_count = EXCLUDED.record_count,
               content_hash = EXCLUDED.content_hash`,
        [
          event.request_id,
          artifact.object,
          artifact.uri,
          artifact.bytes ?? null,
          artifact.record_count ?? null,
          artifact.content_hash ?? null,
        ]
      );
      await pool.query(
        `INSERT INTO extraction_objects (request_id, object, status, records_written, updated_at)
         VALUES ($1, $2, 'succeeded', $3, $4)
         ON CONFLICT (request_id, object) DO UPDATE
           SET status = 'succeeded',
               records_written = EXCLUDED.records_written,
               updated_at = EXCLUDED.updated_at`,
        [event.request_id, artifact.object, artifact.record_count || 0, at]
      );
    }
    return;
  }

  if (event.event === "failed") {
    await pool.query(
      `UPDATE extraction_requests
       SET status = 'failed', updated_at = $2, error_message = $3
       WHERE id = $1 AND status <> 'cancelled'`,
      [event.request_id, at, event.error || "failed"]
    );
    if (event.run_id || event.attempt) {
      await pool.query(
        `UPDATE extraction_runs
         SET finished_at = $3, error = $4
         WHERE request_id = $1 AND ($2::uuid IS NULL OR id = $2)
           AND ($5::int IS NULL OR attempt = $5)`,
        [
          event.request_id,
          event.run_id || null,
          at,
          event.error || "failed",
          event.attempt || null,
        ]
      );
    }
  }
}

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.eventsTopic, fromBeginning: false });
  console.log(`[status-writer] consuming ${cfg.eventsTopic} on ${kafkaConfig().brokers.join(",")}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const raw = message.value?.toString("utf8") || "{}";
        const event = assertEvent(JSON.parse(raw));
        await applyEvent(event);
        console.log(`[status-writer] ${event.event} ${event.request_id}`);
      } catch (error) {
        console.error("[status-writer] failed to apply event", error.message);
      }
    },
  });

  const shutdown = async () => {
    await consumer.disconnect().catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[status-writer] fatal", error);
  process.exit(1);
});
