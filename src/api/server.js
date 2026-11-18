import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadApiConfig, loadAuthConfig } from "./config.js";
import { createAuthService } from "./auth/service.js";
import { loadMongoConfig } from "../storage/mongodbConfig.js";
import { openMongoDatabase } from "../storage/mongodbConnection.js";

async function startServer() {
  const config = loadApiConfig();
  const authConfig = loadAuthConfig();
  const mongoConfig = process.env.MONGO_URL || process.env.MONGODB_URI
    ? loadMongoConfig() : null;
  const auth = await createAuthService(authConfig);
  const { host, port } = config;
  let databaseConnection;
  let server;

  async function closeResources() {
    const results = await Promise.allSettled([
      auth.sessions.close(),
      databaseConnection ? databaseConnection.close() : Promise.resolve(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("API resource cleanup failed.");
    }
  }

  try {
    if (mongoConfig) databaseConnection = await openMongoDatabase(mongoConfig);
    server = createServer({
      requestTimeout: config.requestTimeoutMs,
      headersTimeout: Math.min(10000, config.requestTimeoutMs),
      keepAliveTimeout: 5000,
    }, createApp(config, auth, authConfig, databaseConnection?.db));
  } catch (error) {
    await closeResources().catch(() => console.error("[api] Resource cleanup failed."));
    throw error;
  }
  server.setTimeout(config.requestTimeoutMs);
  let shuttingDown = false;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await closeResources().catch(() => console.error("[api] Resource cleanup failed."));
    if (error.code === "EADDRINUSE") {
      throw new Error(`Port ${port} is already in use. Choose another API_PORT.`);
    }
    throw error;
  }
  const address = host.includes(":") ? `[${host}]` : host;
  console.info(`[api] Listening on http://${address}:${port}`);

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[api] ${signal} received. Shutting down.`);

    // Give active requests time to finish, but do not wait indefinitely.
    const timer = setTimeout(() => {
      console.error("[api] Shutdown timed out after 10 seconds.");
      process.exit(1);
    }, 10_000);
    timer.unref();

    server.close(async (error) => {
      try {
        await closeResources();
      } catch {
        console.error("[api] Resource shutdown failed.");
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
      if (error) {
        console.error(`[api] Shutdown failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      console.info("[api] Server stopped.");
    });
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  await startServer();
} catch (error) {
  console.error(`[api] Could not start: ${error.message}`);
  process.exitCode = 1;
}
