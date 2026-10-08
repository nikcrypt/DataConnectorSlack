import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const DEFAULT_BATCH_SIZE = 200;

/** Writes normalized records for every connector into the database named in MONGO_URL. */
export class MongoRuntime {
  /**
   * @param {import('../connectors/base/DataConnector.js').DataConnector} connector
   * @param {{ uri?: string, batchSize?: number, createClient?: (uri: string) => object }} [options]
   */
  constructor(connector, options = {}) {
    const uri = options.uri || process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("Missing MONGO_URL or MONGODB_URI. Set it in .env");
    }
    this.connector = connector;
    this.connectorKey = connector.getConnectorKey?.() || "unknown";
    this.uri = uri;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.createClient = options.createClient || ((mongoUri) => new MongoClient(mongoUri));
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error("MongoDB batchSize must be a positive integer");
    }
  }

  async run({ objects, mode = "full", checkpoint, startedAt } = {}) {
    const selected = objects?.length ? objects : this.connector.getObjects();
    const client = this.createClient(this.uri);
    const runId = randomUUID();
    const runStartedAt = new Date(startedAt || Date.now());
    const startedAtIso = runStartedAt.toISOString();
    const summary = {
      runId,
      connector: this.connectorKey,
      mode,
      startedAt: startedAtIso,
      objects: {},
    };

    try {
      await client.connect();
      const db = client.db(databaseNameFromUri(this.uri));
      const records = db.collection(this.connectorKey);
      const runs = db.collection("extraction_runs");
      const checkpoints = db.collection("extraction_checkpoints");

      await records.createIndex(
        { object: 1, sourceId: 1 },
        { unique: true, name: "records_identity" }
      );
      await runs.createIndex(
        { connectorKey: 1, startedAt: -1 },
        { name: "runs_by_connector" }
      );
      await runs.insertOne({
        runId,
        connectorKey: this.connectorKey,
        status: "running",
        mode,
        startedAt: runStartedAt,
        objects: {},
      });

      const objectCheckpoints = mode === "incremental"
        ? checkpoint
          ? { ...checkpoint }
          : await loadCheckpoints(checkpoints, this.connectorKey, selected)
        : {};
      if (mode === "incremental") {
        for (const object of selected) {
          if (requiresCheckpoint(this.connector, object) && !objectCheckpoints[object]?.lastSuccessfulAt) {
            throw new Error(
              `Incremental extraction requires a previous successful run checkpoint for ${object}.`
            );
          }
        }
      }

      summary.database = db.databaseName;
      summary.collection = this.connectorKey;
      console.log(`[mongo] ${this.connectorKey} run ${runId} -> ${db.databaseName}.${this.connectorKey}`);
      console.log(`[mongo] checkpoints -> ${db.databaseName}.extraction_checkpoints`);

      try {
        for (const object of selected) {
          const objectCheckpoint = mode === "incremental"
            ? objectCheckpoints[object]
            : null;
          summary.objects[object] = await this.extractObject(
            records,
            object,
            mode,
            objectCheckpoint,
            startedAtIso
          );
        }
        summary.finishedAt = new Date().toISOString();
        summary.status = "succeeded";
        await runs.updateOne(
          { runId },
          {
            $set: {
              status: summary.status,
              finishedAt: new Date(summary.finishedAt),
              objects: summary.objects,
            },
          }
        );
        for (const object of selected) {
          if (!requiresCheckpoint(this.connector, object)) continue;
          await checkpoints.updateOne(
            { connectorKey: this.connectorKey, object },
            { $set: { connectorKey: this.connectorKey, object, lastSuccessfulAt: startedAtIso } },
            { upsert: true }
          );
        }
      } catch (error) {
        summary.finishedAt = new Date().toISOString();
        summary.status = "failed";
        summary.error = safeError(error);
        await runs.updateOne(
          { runId },
          {
            $set: {
              status: summary.status,
              finishedAt: new Date(summary.finishedAt),
              error: summary.error,
              objects: summary.objects,
            },
          }
        );
        throw error;
      }
    } finally {
      await client.close();
    }

    return summary;
  }

  async extractObject(records, object, mode, checkpoint, startedAt) {
    const counts = { extracted: 0, upserted: 0, modified: 0 };
    let batch = [];

    console.log(`[mongo] extracting ${object}...`);
    for await (const record of this.connector.extract(object, {
      mode,
      checkpoint: checkpoint || null,
      startedAt,
    })) {
      batch.push(toDocument(record));
      counts.extracted += 1;

      if (batch.length >= this.batchSize) {
        const written = await flushBatch(records, batch);
        counts.upserted += written.upserted;
        counts.modified += written.modified;
        batch = [];
      }
      if (counts.extracted % 100 === 0) {
        console.log(`[mongo] ${object}: ${counts.extracted} records`);
      }
    }

    if (batch.length) {
      const written = await flushBatch(records, batch);
      counts.upserted += written.upserted;
      counts.modified += written.modified;
    }

    console.log(
      `[mongo] ${object}: done (${counts.extracted} extracted, ${counts.upserted} inserted, ${counts.modified} updated)`
    );
    return counts;
  }
}

function toDocument(record) {
  if (!record.connectorKey || !record.object || record.sourceId == null) {
    throw new Error("Connector record is missing connectorKey, object, or sourceId");
  }

  return {
    connectorKey: record.connectorKey,
    object: record.object,
    sourceId: String(record.sourceId),
    data: record.data,
    rawData: record.rawData ?? null,
    hash: record.hash,
    isDeleted: Boolean(record.isDeleted),
    extractedAt: record.extractedAt ? new Date(record.extractedAt) : new Date(),
    updatedAt: new Date(),
  };
}

async function flushBatch(records, batch) {
  const result = await records.bulkWrite(
    batch.map((doc) => ({
      updateOne: {
        filter: { connectorKey: doc.connectorKey, object: doc.object, sourceId: doc.sourceId },
        update: { $set: doc, $setOnInsert: { createdAt: doc.updatedAt } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  return { upserted: result.upsertedCount || 0, modified: result.modifiedCount || 0 };
}

async function loadCheckpoints(checkpoints, connectorKey, objects) {
  const result = {};
  for (const object of objects) {
    const checkpoint = await checkpoints.findOne({ connectorKey, object });
    if (checkpoint) result[object] = {
      lastSuccessfulAt: checkpoint.lastSuccessfulAt,
    };
  }
  return result;
}

function databaseNameFromUri(uri) {
  const parsed = new URL(uri.replace(/^mongodb(\+srv)?:/, "https:"));
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return name || "data_connector_poc_micro_service";
}

function requiresCheckpoint(connector, object) {
  const checkpoint = connector.getCheckpoint?.(object);
  return checkpoint !== null && checkpoint !== undefined;
}

function safeError(err) {
  return String(err?.message || err).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://***");
}
