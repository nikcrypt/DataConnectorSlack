import { randomUUID } from "node:crypto";

const JIRA_OBJECTS = ["projects", "issues", "users", "statuses", "issueTypes"];
const COLLECTION = "connections";

export function supportedConnectors() {
  return ["jira"];
}

export function jiraObjectNames() {
  return [...JIRA_OBJECTS];
}

export function toPublicConnection(record) {
  if (!record) return null;
  return {
    id: record.id,
    userId: record.userId || null,
    connector: record.connector,
    name: record.name,
    baseUrl: record.baseUrl,
    email: record.email,
    authType: record.authType,
    objects: [...(record.objects || [])],
    status: record.status,
    hasSecret: Boolean(record.apiToken),
    lastTestAt: record.lastTestAt || null,
    lastTestOk: record.lastTestOk ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy || null,
  };
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeUserId(value) {
  const userId = String(value ?? "").trim();
  if (!userId) throw apiError(400, "VALIDATION_ERROR", "userId is required.");
  if (userId.length > 128) {
    throw apiError(400, "VALIDATION_ERROR", "userId must be at most 128 characters.");
  }
  return userId;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw apiError(400, "VALIDATION_ERROR", "baseUrl must be a valid http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw apiError(400, "VALIDATION_ERROR", "baseUrl must use http or https.");
  }
  if (url.username || url.password) {
    throw apiError(400, "VALIDATION_ERROR", "baseUrl must not include credentials.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

function normalizeEmail(value) {
  const email = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw apiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }
  return email;
}

function normalizeObjects(objects) {
  const list = Array.isArray(objects)
    ? objects.map((item) => String(item).trim()).filter(Boolean)
    : [...JIRA_OBJECTS];
  if (!list.length) {
    throw apiError(400, "VALIDATION_ERROR", "Select at least one Jira object.");
  }
  const unknown = list.filter((name) => !JIRA_OBJECTS.includes(name));
  if (unknown.length) {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      `Unknown Jira object(s): ${unknown.join(", ")}. Valid: ${JIRA_OBJECTS.join(", ")}`
    );
  }
  return [...new Set(list)];
}

export function buildJiraConnectionRecord(body = {}, { createdBy } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }

  const allowed = new Set([
    "connector",
    "userId",
    "user_id",
    "userid",
    "name",
    "baseUrl",
    "endpoint",
    "email",
    "account",
    "apiToken",
    "api_token",
    "secret",
    "authType",
    "auth",
    "objects",
  ]);
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      `Unsupported field(s): ${unexpected.join(", ")}.`
    );
  }

  const connector = String(body.connector || "").trim().toLowerCase();
  if (connector !== "jira") {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      `Unsupported connector "${body.connector || ""}". Supported: jira`
    );
  }

  const name = String(body.name || "").trim();
  if (!name || name.length > 80) {
    throw apiError(400, "VALIDATION_ERROR", "name is required (max 80 characters).");
  }

  const authType = String(body.authType || body.auth || "api_token")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (authType !== "api_token" && authType !== "api-token") {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      'Jira registration currently supports authType "api_token" only.'
    );
  }

  const apiToken = String(body.apiToken || body.api_token || body.secret || "").trim();
  if (!apiToken) {
    throw apiError(400, "VALIDATION_ERROR", "apiToken is required.");
  }

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    userId: normalizeUserId(body.userId ?? body.user_id ?? body.userid),
    connector: "jira",
    name,
    baseUrl: normalizeBaseUrl(body.baseUrl || body.endpoint),
    email: normalizeEmail(body.email || body.account),
    apiToken,
    authType: "api_token",
    objects: normalizeObjects(body.objects),
    status: "connected",
    lastTestAt: null,
    lastTestOk: null,
    createdAt: now,
    updatedAt: now,
    createdBy: createdBy || null,
  };
}

export async function createConnection(database, body, options = {}) {
  const record = buildJiraConnectionRecord(body, options);
  await database.collection(COLLECTION).insertOne({ ...record });
  return record;
}

export async function ensureConnectionsIndexes(database) {
  const collection = database.collection(COLLECTION);
  await collection.createIndex({ id: 1 }, { unique: true, name: "connections_id" });
  await collection.createIndex(
    { userId: 1, connector: 1, createdAt: -1 },
    { name: "connections_by_user_connector" }
  );
}
