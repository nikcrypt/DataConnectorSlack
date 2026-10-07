import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const DEFAULT_BATCH_SIZE = 200;

/** Writes normalized records from any connector to its own MongoDB database. */
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
    this.databaseName = `data_connector_${this.connectorKey}`;
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
      const db = client.db(this.databaseName);
      const records = db.collection("records");
      const runs = db.collection("extraction_runs");

      await records.createIndex(
        { connectorKey: 1, object: 1, sourceId: 1 },
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
        startedAt,
        objects: {},
      });

      console.log(`[mongo] ${this.connectorKey} run ${runId} -> ${db.databaseName}.records`);

      try {
        for (const object of selected) {
          summary.objects[object] = await this.extractObject(records, object, mode);
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

  async extractObject(records, object, mode) {
    const counts = { extracted: 0, upserted: 0, modified: 0 };
    let batch = [];

    console.log(`[mongo] extracting ${object}...`);
    for await (const record of this.connector.extract(object, { mode })) {
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

function safeError(error) {
  return String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://***");
}