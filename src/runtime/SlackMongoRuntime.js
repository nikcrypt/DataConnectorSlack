import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const BATCH_SIZE = 200;

const MONGO_CONNECTORS = new Set(["slack", "jira"]);

/**
 * Upserts extracted records into MongoDB.
 * Enabled for Slack and Jira. Unique key: connectorKey + object + sourceId.
 */
export class SlackMongoRuntime {
  /**
   * @param {import('../connectors/base/DataConnector.js').DataConnector} connector
   * @param {{ uri?: string, batchSize?: number }} [options]
   */
  constructor(connector, options = {}) {
    const uri = options.uri || process.env.MONGO_URL;
    if (!uri) {
      throw new Error("Missing MONGO_URL. Set it in .env");
    }
    const connectorKey = connector.getConnectorKey?.();
    if (!MONGO_CONNECTORS.has(connectorKey)) {
      throw new Error("MongoDB extract is only implemented for Slack and Jira");
    }
    this.connector = connector;
    this.connectorKey = connectorKey;
    this.uri = uri;
    this.batchSize = options.batchSize || BATCH_SIZE;
  }

  async run({ objects, mode = "full" } = {}) {
    const selected = objects?.length ? objects : this.connector.getObjects();
    const client = new MongoClient(this.uri);
    const runId = randomUUID();
    const startedAt = new Date();
    const summary = {
      runId,
      connector: this.connectorKey,
      mode,
      startedAt: startedAt.toISOString(),
      objects: {},
    };

    await client.connect();
    try {
      const db = client.db();
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
              status: "succeeded",
              finishedAt: new Date(summary.finishedAt),
              objects: summary.objects,
            },
          }
        );
      } catch (err) {
        summary.finishedAt = new Date().toISOString();
        summary.status = "failed";
        summary.error = safeError(err);
        await runs.updateOne(
          { runId },
          {
            $set: {
              status: "failed",
              finishedAt: new Date(summary.finishedAt),
              error: summary.error,
              objects: summary.objects,
            },
          }
        );
        throw err;
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
        filter: {
          connectorKey: doc.connectorKey,
          object: doc.object,
          sourceId: doc.sourceId,
        },
        update: {
          $set: doc,
          $setOnInsert: { createdAt: doc.updatedAt },
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

function safeError(err) {
  return String(err?.message || err).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://***");
}
