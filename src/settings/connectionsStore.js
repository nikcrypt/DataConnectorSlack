import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONNECTIONS_DIR = path.resolve("data/connections");
const JIRA_OBJECTS = ["projects", "issues", "users", "statuses", "issueTypes"];

export function supportedConnectionConnectors() {
  return ["jira"];
}

export function jiraObjectNames() {
  return [...JIRA_OBJECTS];
}

async function ensureDir() {
  await mkdir(CONNECTIONS_DIR, { recursive: true });
}

function connectionPath(id) {
  const safe = String(id || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(safe)) {
    throw Object.assign(new Error("Invalid connection id"), { status: 400 });
  }
  return path.join(CONNECTIONS_DIR, `${safe.toLowerCase()}.json`);
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

function normalizeUserId(value) {
  const userId = String(value ?? "").trim();
  if (!userId) {
    throw Object.assign(new Error("userId is required"), { status: 400 });
  }
  if (userId.length > 128) {
    throw Object.assign(new Error("userId must be at most 128 characters"), { status: 400 });
  }
  return userId;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("baseUrl must be a valid http(s) URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("baseUrl must use http or https"), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("baseUrl must not include credentials"), { status: 400 });
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

function normalizeEmail(value) {
  const email = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("email must be a valid email address"), { status: 400 });
  }
  return email;
}

function normalizeObjects(objects) {
  const list = Array.isArray(objects)
    ? objects.map((item) => String(item).trim()).filter(Boolean)
    : [...JIRA_OBJECTS];
  if (!list.length) {
    throw Object.assign(new Error("Select at least one Jira object"), { status: 400 });
  }
  const unknown = list.filter((name) => !JIRA_OBJECTS.includes(name));
  if (unknown.length) {
    throw Object.assign(
      new Error(`Unknown Jira object(s): ${unknown.join(", ")}. Valid: ${JIRA_OBJECTS.join(", ")}`),
      { status: 400 }
    );
  }
  return [...new Set(list)];
}

function normalizeCreateBody(body = {}, { createdBy } = {}) {
  const connector = String(body.connector || "").trim().toLowerCase();
  if (connector !== "jira") {
    throw Object.assign(
      new Error(`Unsupported connector "${body.connector || ""}". Supported: jira`),
      { status: 400 }
    );
  }

  const name = String(body.name || "").trim();
  if (!name || name.length > 80) {
    throw Object.assign(new Error("name is required (max 80 characters)"), { status: 400 });
  }

  const authType = String(body.authType || body.auth || "api_token")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (authType !== "api_token" && authType !== "api-token") {
    throw Object.assign(
      new Error('Jira registration currently supports authType "api_token" only'),
      { status: 400 }
    );
  }

  const apiToken = String(body.apiToken || body.api_token || body.secret || "").trim();
  if (!apiToken) {
    throw Object.assign(new Error("apiToken is required"), { status: 400 });
  }

  const userId = normalizeUserId(body.userId ?? body.user_id ?? body.userid);

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    userId,
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

function normalizePatchBody(existing, body = {}) {
  const next = { ...existing, updatedAt: new Date().toISOString() };

  if (body.userId !== undefined || body.user_id !== undefined || body.userid !== undefined) {
    next.userId = normalizeUserId(body.userId ?? body.user_id ?? body.userid);
  }
  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name || name.length > 80) {
      throw Object.assign(new Error("name is required (max 80 characters)"), { status: 400 });
    }
    next.name = name;
  }
  if (body.baseUrl !== undefined || body.endpoint !== undefined) {
    next.baseUrl = normalizeBaseUrl(body.baseUrl || body.endpoint);
  }
  if (body.email !== undefined || body.account !== undefined) {
    next.email = normalizeEmail(body.email || body.account);
  }
  if (body.apiToken !== undefined || body.api_token !== undefined || body.secret !== undefined) {
    const apiToken = String(body.apiToken || body.api_token || body.secret || "").trim();
    if (!apiToken) {
      throw Object.assign(new Error("apiToken cannot be empty"), { status: 400 });
    }
    next.apiToken = apiToken;
  }
  if (body.objects !== undefined) {
    next.objects = normalizeObjects(body.objects);
  }
  if (body.status !== undefined) {
    const status = String(body.status).trim().toLowerCase();
    if (!["connected", "attention", "disconnected"].includes(status)) {
      throw Object.assign(new Error("status must be connected, attention, or disconnected"), {
        status: 400,
      });
    }
    next.status = status;
  }

  return next;
}

async function writeConnection(record) {
  await ensureDir();
  const filePath = connectionPath(record.id);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function createConnection(body, options = {}) {
  const record = normalizeCreateBody(body, options);
  await writeConnection(record);
  return record;
}

export async function listConnections({ connector, userId } = {}) {
  await ensureDir();
  const names = await readdir(CONNECTIONS_DIR);
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(CONNECTIONS_DIR, name), "utf8");
      records.push(JSON.parse(raw));
    } catch {
      // skip corrupt files
    }
  }
  let filtered = records;
  if (connector) {
    filtered = filtered.filter((item) => item.connector === String(connector).toLowerCase());
  }
  if (userId) {
    const wanted = String(userId).trim();
    filtered = filtered.filter((item) => String(item.userId || "") === wanted);
  }
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getConnection(id) {
  try {
    const raw = await readFile(connectionPath(id), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("Connection not found"), { status: 404 });
    }
    throw error;
  }
}

export async function updateConnection(id, body) {
  const existing = await getConnection(id);
  const next = normalizePatchBody(existing, body);
  await writeConnection(next);
  return next;
}

export async function deleteConnection(id) {
  await getConnection(id);
  await unlink(connectionPath(id));
  return { ok: true, id };
}

export async function markConnectionTest(id, { ok, error = null } = {}) {
  const existing = await getConnection(id);
  existing.lastTestAt = new Date().toISOString();
  existing.lastTestOk = Boolean(ok);
  existing.status = ok ? "connected" : "attention";
  existing.updatedAt = existing.lastTestAt;
  if (error) existing.lastTestError = String(error);
  else delete existing.lastTestError;
  await writeConnection(existing);
  return existing;
}
