import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/config.js";
import { closePool, getPool } from "../shared/db.js";
import { createKafka, publishJson } from "../shared/kafka.js";
import { createS3Client, ensureBucket, putJsonl } from "../shared/minio.js";
import { assertCommand, assertEvent } from "../shared/validate.js";

const connectorKey = env("CONNECTOR_KEY", "slack").toLowerCase();
const workerId = env("WORKER_ID", `${connectorKey}-${process.pid}`);
const workerMode = env("WORKER_MODE", "stub"); // stub | live
const { cfg, kafka } = createKafka(`worker-${connectorKey}`);
const consumer = kafka.consumer({ groupId: `connector-${connectorKey}` });
const producer = kafka.producer();
const { client: s3, cfg: minio } = createS3Client();

async function emit(event) {
  const payload = assertEvent({
    connector_key: connectorKey,
    worker_id: workerId,
    at: new Date().toISOString(),
    ...event,
  });
  await publishJson(producer, cfg.eventsTopic, connectorKey, payload);
}

async function loadRequest(requestId) {
  const result = await getPool().query(
    "SELECT * FROM extraction_requests WHERE id = $1",
    [requestId]
  );
  return result.rows[0] || null;
}

async function runStubExtract(request, objects) {
  const artifacts = [];
  const selected = objects.length ? objects : ["sample"];
  for (const object of selected) {
    const lines = [];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(
        JSON.stringify({
          connectorKey: request.connector_key,
          object,
          sourceId: `${object}-${i}`,
          data: { index: i, requestId: request.id },
          hash: `stub-${object}-${i}`,
          isDeleted: false,
          extractedAt: new Date().toISOString(),
        })
      );
    }
    await emit({
      request_id: request.id,
      event: "progress",
      object,
      records_written: lines.length,
      run_id: request._runId,
      attempt: request._attempt,
    });
    const key = `${request.tenant_id}/${request.connector_key}/${request.id}/${object}.jsonl`;
    const uploaded = await putJsonl(s3, minio.bucket, key, lines);
    artifacts.push({ object, ...uploaded });
  }
  return artifacts;
}

async function runLiveExtract(request, objects) {
  // Live mode reuses Phase 1 runtime from the monorepo image (/app/src).
  const { ConnectorRuntimeEngine } = await import(
    new URL("../../../src/runtime/ConnectorRuntimeEngine.js", import.meta.url).href
  );
  const connector = await createLiveConnector(request.connector_key);
  const outputRoot = path.resolve("/tmp/extracts", request.id);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const runtime = new ConnectorRuntimeEngine(connector, { outputDir: outputRoot });
  const selected = objects.length ? objects : connector.getObjects();
  const summary = await runtime.run({
    objects: selected,
    mode: request.mode || "full",
  });

  const artifacts = [];
  for (const object of selected) {
    const filePath = path.join(outputRoot, request.connector_key, `${object}.jsonl`);
    let lines = [];
    try {
      const raw = await readFile(filePath, "utf8");
      lines = raw.split("\n").filter(Boolean);
    } catch {
      lines = [];
    }
    await emit({
      request_id: request.id,
      event: "progress",
      object,
      records_written: summary.objects?.[object]?.extracted ?? lines.length,
      run_id: request._runId,
      attempt: request._attempt,
    });
    const key = `${request.tenant_id}/${request.connector_key}/${request.id}/${object}.jsonl`;
    const uploaded = await putJsonl(s3, minio.bucket, key, lines);
    artifacts.push({ object, ...uploaded });
  }

  await rm(outputRoot, { recursive: true, force: true }).catch(() => {});
  return artifacts;
}

async function createLiveConnector(name) {
  switch (name) {
    case "slack": {
      const { SlackConnector } = await import(
        new URL("../../../src/connectors/slack/SlackConnector.js", import.meta.url).href
      );
      const { loadSlackAuth, getBotTokenFromEnvOrAuth } = await import(
        new URL("../../../src/connectors/slack/tokenStore.js", import.meta.url).href
      );
      const auth = await loadSlackAuth();
      const botToken = getBotTokenFromEnvOrAuth(auth);
      if (!botToken) throw new Error("Missing SLACK_BOT_TOKEN for live Slack worker");
      return new SlackConnector({ botToken });
    }
    default:
      throw new Error(
        `Live worker mode is only wired for slack in this skeleton (got ${name}). Use WORKER_MODE=stub or add a factory case.`
      );
  }
}

async function processCommand(command) {
  const request = await loadRequest(command.request_id);
  if (!request) {
    console.warn(`[worker] unknown request ${command.request_id}`);
    return;
  }
  if (request.status === "cancelled") {
    console.log(`[worker] skip cancelled ${request.id}`);
    return;
  }
  if (request.status === "succeeded") {
    console.log(`[worker] skip already succeeded ${request.id}`);
    return;
  }
  if (request.connector_key !== connectorKey) {
    return;
  }

  const runId = randomUUID();
  const attempt = 1;
  request._runId = runId;
  request._attempt = attempt;

  await emit({
    request_id: request.id,
    event: "started",
    run_id: runId,
    attempt,
  });

  try {
    await ensureBucket(s3, minio.bucket);
    const objects = Array.isArray(request.objects) ? request.objects : [];
    const artifacts =
      workerMode === "live"
        ? await runLiveExtract(request, objects)
        : await runStubExtract(request, objects);

    const latest = await loadRequest(request.id);
    if (latest?.status === "cancelled") {
      console.log(`[worker] cancelled during run ${request.id}`);
      return;
    }

    await emit({
      request_id: request.id,
      event: "completed",
      run_id: runId,
      attempt,
      artifacts,
    });
    console.log(`[worker] completed ${request.id} artifacts=${artifacts.length}`);
  } catch (error) {
    await emit({
      request_id: request.id,
      event: "failed",
      run_id: runId,
      attempt,
      error: error.message,
    });
    console.error(`[worker] failed ${request.id}:`, error.message);
  }
}

async function main() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.commandsTopic, fromBeginning: false });
  console.log(
    `[worker] connector=${connectorKey} mode=${workerMode} id=${workerId} topic=${cfg.commandsTopic}`
  );

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const raw = message.value?.toString("utf8") || "{}";
        const command = assertCommand(JSON.parse(raw));
        if (command.connector_key !== connectorKey) return;
        await processCommand(command);
      } catch (error) {
        console.error("[worker] command error", error.message);
        try {
          await publishJson(producer, cfg.dlqTopic, connectorKey, {
            error: error.message,
            raw: message.value?.toString("utf8") || null,
            at: new Date().toISOString(),
          });
        } catch {
          /* ignore dlq publish errors */
        }
      }
    },
  });

  const shutdown = async () => {
    await consumer.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
