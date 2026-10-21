/**
 * Lightweight structural checks for Phase 2 messages (no ajv dependency).
 * Full JSON Schema files live in phase2/schemas/ for documentation and later tooling.
 */

export function assertCommand(message) {
  if (!message || typeof message !== "object") {
    throw new Error("command must be an object");
  }
  if (!isUuid(message.request_id)) {
    throw new Error("command.request_id must be a UUID");
  }
  if (!message.connector_key || typeof message.connector_key !== "string") {
    throw new Error("command.connector_key is required");
  }
  if (!message.requested_at || Number.isNaN(Date.parse(message.requested_at))) {
    throw new Error("command.requested_at must be an ISO date-time");
  }
  if (message.mode && !["full", "incremental"].includes(message.mode)) {
    throw new Error("command.mode must be full or incremental");
  }
  return message;
}

export function assertEvent(message) {
  if (!message || typeof message !== "object") {
    throw new Error("event must be an object");
  }
  if (!isUuid(message.request_id)) {
    throw new Error("event.request_id must be a UUID");
  }
  if (!["started", "progress", "completed", "failed"].includes(message.event)) {
    throw new Error("event.event must be started|progress|completed|failed");
  }
  if (!message.connector_key || typeof message.connector_key !== "string") {
    throw new Error("event.connector_key is required");
  }
  if (!message.at || Number.isNaN(Date.parse(message.at))) {
    throw new Error("event.at must be an ISO date-time");
  }
  return message;
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}
