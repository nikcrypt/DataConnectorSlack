import { randomUUID } from "node:crypto";
import { ConnectorRuntimeEngine } from "../runtime/ConnectorRuntimeEngine.js";
import { MongoRuntime } from "../runtime/MongoRuntime.js";
import { createConnector } from "./createConnector.js";

/** @type {Map<string, object>} */
const jobs = new Map();

export function getExtractJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Start a local extract in the background.
 * target: "mongo" → MongoRuntime (npm run extract:*:mongo)
 * target: "jsonl" → ConnectorRuntimeEngine → data/output/<connector>/
 */
export function startExtractJob({ connectorKey, objects, mode, target, requestedBy }) {
  const destination = target === "jsonl" ? "jsonl" : "mongo";
  if (destination === "mongo" && !process.env.MONGO_URL && !process.env.MONGODB_URI) {
    throw Object.assign(
      new Error("Missing MONGO_URL in .env. Set it before running Mongo extracts from the UI."),
      { status: 400 }
    );
  }

  const id = randomUUID();
  const job = {
    id,
    request_id: id,
    connector_key: connectorKey,
    objects: Array.isArray(objects) ? objects : [],
    mode: mode === "incremental" ? "incremental" : "full",
    target: destination,
    destination:
      destination === "mongo"
        ? "MongoDB (MONGO_URL database, collection = connector key)"
        : "Local JSONL (data/output/<connector>/)",
    requested_by: requestedBy || null,
    status: "queued",
    error: null,
    summary: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
  };
  jobs.set(id, job);

  queueMicrotask(() => {
    runJob(job).catch((error) => {
      job.status = "failed";
      job.error = error.message;
      job.finished_at = new Date().toISOString();
      console.error(`[settings-extract] ${job.id} failed:`, error.message);
    });
  });

  return {
    request_id: id,
    status: job.status,
    connector_key: job.connector_key,
    mode: job.mode,
    target: job.target,
    destination: job.destination,
    objects: job.objects,
  };
}

async function runJob(job) {
  job.status = "running";
  job.started_at = new Date().toISOString();
  console.log(
    `[settings-extract] ${job.id} ${job.connector_key} target=${job.target} mode=${job.mode} objects=${job.objects.join(",") || "(all)"}`
  );

  const connector = await createConnector(job.connector_key);
  const known = new Set(connector.getObjects());
  const selected = job.objects.length ? job.objects : connector.getObjects();
  const unknown = selected.filter((object) => !known.has(object));
  if (unknown.length) {
    throw new Error(
      `Unknown ${job.connector_key} object: ${unknown.join(", ")}. Valid: ${connector.getObjects().join(", ")}`
    );
  }

  if (job.target === "jsonl") {
    const runtime = new ConnectorRuntimeEngine(connector);
    const summary = await runtime.run({ objects: selected, mode: job.mode });
    job.summary = {
      status: "succeeded",
      target: "jsonl",
      outputDir: `data/output/${job.connector_key}/`,
      objects: summary.objects,
    };
    job.status = "succeeded";
    job.error = null;
  } else {
    const runtime = new MongoRuntime(connector);
    const summary = await runtime.run({ objects: selected, mode: job.mode });
    job.summary = {
      runId: summary.runId,
      status: summary.status,
      target: "mongo",
      database: summary.database,
      collection: summary.collection,
      objects: summary.objects,
      error: summary.error || null,
    };
    job.status = summary.status === "failed" ? "failed" : "succeeded";
    job.error = summary.error || null;
  }

  job.finished_at = new Date().toISOString();
  console.log(`[settings-extract] ${job.id} ${job.status} target=${job.target}`);
}
