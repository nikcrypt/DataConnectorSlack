export function env(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

export function postgresConfig() {
  return {
    connectionString: env(
      "DATABASE_URL",
      "postgresql://connector:connector@localhost:5432/connector_platform"
    ),
  };
}

export function kafkaConfig() {
  return {
    clientId: env("KAFKA_CLIENT_ID", "connector-platform"),
    brokers: env("KAFKA_BROKERS", "localhost:9092").split(",").map((b) => b.trim()),
    commandsTopic: env("KAFKA_COMMANDS_TOPIC", "extract.commands"),
    eventsTopic: env("KAFKA_EVENTS_TOPIC", "extract.events"),
    dlqTopic: env("KAFKA_DLQ_TOPIC", "extract.dlq"),
  };
}

export function minioConfig() {
  return {
    endpoint: env("MINIO_ENDPOINT", "http://localhost:9000"),
    region: env("MINIO_REGION", "us-east-1"),
    accessKeyId: env("MINIO_ACCESS_KEY", "minioadmin"),
    secretAccessKey: env("MINIO_SECRET_KEY", "minioadmin"),
    bucket: env("MINIO_BUCKET", "extracts"),
    forcePathStyle: true,
  };
}
