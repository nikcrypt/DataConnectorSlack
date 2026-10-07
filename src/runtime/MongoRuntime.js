import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const DEFAULT_BATCH_SIZE = 200;

/** Writes normalized records for every connector into one MongoDB database. */
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
    this.collectionName = this.connectorKey;
    this.uri = uri;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.createClient = options.createClient || ((mongoUri) => new MongoClient(mongoUri));
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error("MongoDB batchSize must be a positive integer");
    }
  }

  async run({ objects, mode = "full" } = {}) {
    const selected = objects?.length ? objects : this.connector.getObjects();
    const client = this.createClient(this.uri);
    const runId = randomUUID();
    const startedAt = new Date();
    const summary = {
      runId,
      connector: this.connectorKey,
      mode,
      startedAt: startedAt.toISOString(),
      objects: {},
    };

    try {
      await client.connect();
      const db = client.db(databaseNameFromUri(this.uri));
      const records = db.collection(this.collectionName);
      const runs = db.collection("extraction_runs");
      const checkpoints = db.collection("checkpoints");
      this.records = records;
      this.runs = runs;
      this.checkpoints = checkpoints;
      this.runId = runId;

      await records.createIndex(
        { object: 1, sourceId: 1 },
        { unique: true, name: "records_identity" }
      );
      await runs.createIndex(
        { connectorKey: 1, startedAt: -1 },
        { name: "runs_by_connector" }
      );
      await checkpoints.createIndex(
        { connectorKey: 1, object: 1 },
        { unique: true, name: "checkpoint_identity" }
      );
      await runs.insertOne({
        runId,
        connectorKey: this.connectorKey,
        status: "running",
        mode,
        startedAt,
        objects: {},
      });

      const previous = await runs.findOne(
        { connectorKey: this.connectorKey, runId: { $ne: runId } },
        { sort: { startedAt: -1 } }
      );
      this.resume = Boolean(previous && previous.status !== "succeeded");
      summary.database = db.databaseName;
      summary.collection = this.collectionName;
      console.log(`[mongo] ${this.connectorKey} run ${runId} -> ${db.databaseName}.${this.collectionName}`);
      if (this.resume) {
        console.log(
          `[mongo] previous run ${previous.runId} ended ${previous.status}, resuming from checkpoints`
        );
      }

      try {
        for (const object of selected) {
          summary.objects[object] = await this.extractObject(object, mode);
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

  async extractObject(object, mode) {
    const existing = this.resume
      ? await this.checkpoints.findOne({ connectorKey: this.connectorKey, object })
      : null;

    if (existing?.status === "complete") {
      console.log(
        `[mongo] ${object}: checkpoint already complete (${existing.recordsSaved || 0} records), skipping`
      );
      return { extracted: 0, upserted: 0, modified: 0, skipped: existing.recordsSaved || 0 };
    }

    const counts = { extracted: 0, upserted: 0, modified: 0 };
    let batch = [];
    let cursor = existing?.cursor || { channels: {} };
    let recordsSaved = existing?.recordsSaved || 0;

    if (recordsSaved > 0) {
      const channels = Object.keys(cursor.channels || {}).length;
      console.log(
        `[mongo] ${object}: resuming after ${recordsSaved} saved records` +
          (channels ? ` across ${channels} channels` : "")
      );
    } else {
      console.log(`[mongo] extracting ${object}...`);
    }

    for await (const record of this.connector.extract(object, { mode, checkpoint: cursor })) {
      batch.push(toDocument(record));
      counts.extracted += 1;

      if (batch.length >= this.batchSize) {
        const written = await this.flushAndCheckpoint(object, batch, cursor, recordsSaved);
        counts.upserted += written.upserted;
        counts.modified += written.modified;
        recordsSaved = written.recordsSaved;
        cursor = written.cursor;
        batch = [];
      }
      if (counts.extracted % 100 === 0) {
        console.log(`[mongo] ${object}: ${counts.extracted} records this run`);
      }
    }

    if (batch.length) {
      const written = await this.flushAndCheckpoint(object, batch, cursor, recordsSaved);
      counts.upserted += written.upserted;
      counts.modified += written.modified;
      recordsSaved = written.recordsSaved;
    }

    await this.checkpoints.updateOne(
      { connectorKey: this.connectorKey, object },
      {
        $set: {
          connectorKey: this.connectorKey,
          object,
          status: "complete",
          recordsSaved,
          runId: this.runId,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log(
      `[mongo] ${object}: done (${counts.extracted} extracted, ${counts.upserted} inserted, ${counts.modified} updated, ${recordsSaved} saved total)`
    );
    return counts;
  }

  async flushAndCheckpoint(object, batch, cursor, recordsSaved) {
    const written = await flushBatch(this.records, batch);
    const nextCursor = mergeCursor(cursor, batch);
    const nextSaved = recordsSaved + batch.length;
    await this.checkpoints.updateOne(
      { connectorKey: this.connectorKey, object },
      {
        $set: {
          connectorKey: this.connectorKey,
          object,
          status: "in_progress",
          cursor: nextCursor,
          recordsSaved: nextSaved,
          runId: this.runId,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    return { ...written, cursor: nextCursor, recordsSaved: nextSaved };
  }
}

function databaseNameFromUri(uri) {
  const parsed = new URL(uri.replace(/^mongodb(\+srv)?:/, "https:"));
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return name || "data_connector_poc_micro_service";
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
    batch.map((document) => ({
      updateOne: {
        filter: {
          connectorKey: document.connectorKey,
          object: document.object,
          sourceId: document.sourceId,
        },
        update: {
          $set: document,
          $setOnInsert: { createdAt: document.updatedAt },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  return {
    upserted: result.upsertedCount || 0,
    modified: result.modifiedCount || 0,
  };
}

function mergeCursor(cursor, batch) {
  const channels = { ...(cursor?.channels || {}) };
  for (const document of batch) {
    const channelId = document.data?.channelId;
    const timestamp = document.data?.timestamp;
    if (!channelId || timestamp == null) continue;
    const latest = String(timestamp);
    const previous = channels[channelId]?.latest_ts;
    if (!previous || latest > String(previous)) {
      channels[channelId] = { latest_ts: latest };
    }
  }
  return { channels };
}

function safeError(error) {
  return String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://***");
}