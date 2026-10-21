import { Kafka, logLevel } from "kafkajs";
import { kafkaConfig } from "./config.js";

export function createKafka(clientIdSuffix = "") {
  const cfg = kafkaConfig();
  const clientId = clientIdSuffix
    ? `${cfg.clientId}-${clientIdSuffix}`
    : cfg.clientId;
  return {
    cfg,
    kafka: new Kafka({
      clientId,
      brokers: cfg.brokers,
      logLevel: logLevel.ERROR,
      retry: { retries: 8 },
    }),
  };
}

export async function publishJson(producer, topic, key, value) {
  await producer.send({
    topic,
    messages: [
      {
        key: String(key),
        value: JSON.stringify(value),
      },
    ],
  });
}
