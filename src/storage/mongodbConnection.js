import { MongoClient } from "mongodb";

/**
 * Open one MongoDB client for the API process.
 * Caller owns lifecycle and must close() on shutdown.
 */
export async function openMongoDatabase(config) {
  const client = new MongoClient(config.uri, {
    maxPoolSize: config.maxPoolSize,
    connectTimeoutMS: config.connectTimeoutMS,
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
    waitQueueTimeoutMS: config.waitQueueTimeoutMS,
    timeoutMS: config.timeoutMS,
  });

  await client.connect();
  await client.db(config.databaseName).command({ ping: 1 });

  return {
    db: client.db(config.databaseName),
    async close() {
      await client.close();
    },
  };
}
