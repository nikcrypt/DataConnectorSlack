export function loadMongoConfig(env = process.env) {
  const uri = (env.MONGO_URL || env.MONGODB_URI || "").trim();
  if (!uri) {
    throw new Error("MONGO_URL or MONGODB_URI is required.");
  }

  let parsed;
  try {
    parsed = new URL(uri.replace(/^mongodb(\+srv)?:/i, "http:"));
  } catch {
    throw new Error("MongoDB URI is invalid.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) {
    throw new Error("MongoDB URI must include a database name.");
  }

  return {
    uri,
    databaseName,
    maxPoolSize: 10,
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
    waitQueueTimeoutMS: 5000,
    timeoutMS: 10_000,
  };
}
