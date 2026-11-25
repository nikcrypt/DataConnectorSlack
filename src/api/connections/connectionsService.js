import { randomUUID } from "node:crypto";

const JIRA_OBJECTS = ["projects", "issues", "users", "statuses", "issueTypes"];
const SLACK_OBJECTS = [
  "workspaces",
  "users",
  "userGroups",
  "channels",
  "messages",
  "threads",
  "reactions",
  "files",
];
const ORACLE_OBJECTS = ["schemas", "tables", "views", "columns", "table_data"];
const COLLECTION = "connections";

export function supportedConnectors() {
  return ["jira", "slack", "oracle"];
}

export function jiraObjectNames() {
  return [...JIRA_OBJECTS];
}

export function slackObjectNames() {
  return [...SLACK_OBJECTS];
}

export function oracleObjectNames() {
  return [...ORACLE_OBJECTS];
}

export function toPublicConnection(record) {
  if (!record) return null;

  const base = {
    id: record.id,
    userId: record.userId || null,
    connector: record.connector,
    name: record.name,
    authType: record.authType,
    objects: [...(record.objects || [])],
    status: record.status,
    lastTestAt: record.lastTestAt || null,
    lastTestOk: record.lastTestOk ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy || null,
  };

  if (record.connector === "slack") {
    return {
      ...base,
      workspaceUrl: record.workspaceUrl || null,
      account: record.account || null,
      channelIds: [...(record.channelIds || [])],
      historyDays: record.historyDays ?? null,
      hasSecret: Boolean(record.botToken),
      hasUserToken: Boolean(record.userToken),
    };
  }

  if (record.connector === "oracle") {
    return {
      ...base,
      username: record.username,
      connectString: record.connectString,
      host: record.host || null,
      port: record.port ?? null,
      serviceName: record.serviceName || null,
      sid: record.sid || null,
      schemas: [...(record.schemas || [])],
      schemaName: record.schemaName || null,
      tableName: record.tableName || null,
      tablesSpec: record.tablesSpec || null,
      pageSize: record.pageSize ?? null,
      modifiedColumn: record.modifiedColumn || null,
      hasSecret: Boolean(record.password),
    };
  }

  return {
    ...base,
    baseUrl: record.baseUrl,
    email: record.email,
    hasSecret: Boolean(record.apiToken),
  };
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
}

function rejectUnexpectedFields(body, allowed) {
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      `Unsupported field(s): ${unexpected.join(", ")}.`
    );
  }
}

function normalizeUserId(value) {
  const userId = String(value ?? "").trim();
  if (!userId) throw apiError(400, "VALIDATION_ERROR", "userId is required.");
  if (userId.length > 128) {
    throw apiError(400, "VALIDATION_ERROR", "userId must be at most 128 characters.");
  }
  return userId;
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80) {
    throw apiError(400, "VALIDATION_ERROR", "name is required (max 80 characters).");
  }
  return name;
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

function normalizeOptionalWorkspaceUrl(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const raw = String(value).trim().replace(/\/$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw apiError(400, "VALIDATION_ERROR", "workspaceUrl must be a valid http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw apiError(400, "VALIDATION_ERROR", "workspaceUrl must be a valid http(s) URL without credentials.");
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

function normalizeObjects(objects, allowedObjects, label) {
  const list = Array.isArray(objects)
    ? objects.map((item) => String(item).trim()).filter(Boolean)
    : [...allowedObjects];
  if (!list.length) {
    throw apiError(400, "VALIDATION_ERROR", `Select at least one ${label} object.`);
  }
  const unknown = list.filter((name) => !allowedObjects.includes(name));
  if (unknown.length) {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      `Unknown ${label} object(s): ${unknown.join(", ")}. Valid: ${allowedObjects.join(", ")}`
    );
  }
  return [...new Set(list)];
}

function normalizeChannelIds(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of list) {
    if (!/^[CGD][A-Z0-9]+$/i.test(id)) {
      throw apiError(
        400,
        "VALIDATION_ERROR",
        `Invalid Slack channel id "${id}". Expected ids like C… / G… / D….`
      );
    }
  }
  return [...new Set(list)];
}

function normalizeHistoryDays(value) {
  if (value === undefined || value === null || value === "") return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw apiError(400, "VALIDATION_ERROR", "historyDays must be an integer between 1 and 3650.");
  }
  return days;
}

function normalizeSlackBotToken(value) {
  const token = String(value || "").trim();
  if (!token) throw apiError(400, "VALIDATION_ERROR", "botToken is required.");
  if (!token.startsWith("xoxb-")) {
    throw apiError(400, "VALIDATION_ERROR", 'botToken must be a Slack bot token starting with "xoxb-".');
  }
  return token;
}

function normalizeSlackUserToken(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const token = String(value).trim();
  if (!token.startsWith("xoxp-")) {
    throw apiError(400, "VALIDATION_ERROR", 'userToken must be a Slack user token starting with "xoxp-".');
  }
  return token;
}

function timestamps(createdBy) {
  const now = new Date().toISOString();
  return {
    status: "connected",
    lastTestAt: null,
    lastTestOk: null,
    createdAt: now,
    updatedAt: now,
    createdBy: createdBy || null,
  };
}

export function buildJiraConnectionRecord(body = {}, { createdBy } = {}) {
  requireObjectBody(body);
  rejectUnexpectedFields(body, new Set([
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
  ]));

  const connector = String(body.connector || "").trim().toLowerCase();
  if (connector !== "jira") {
    throw apiError(400, "VALIDATION_ERROR", `Expected connector "jira", got "${body.connector || ""}".`);
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

  return {
    id: randomUUID(),
    userId: normalizeUserId(body.userId ?? body.user_id ?? body.userid),
    connector: "jira",
    name: normalizeName(body.name),
    baseUrl: normalizeBaseUrl(body.baseUrl || body.endpoint),
    email: normalizeEmail(body.email || body.account),
    apiToken,
    authType: "api_token",
    objects: normalizeObjects(body.objects, JIRA_OBJECTS, "Jira"),
    ...timestamps(createdBy),
  };
}

export function buildSlackConnectionRecord(body = {}, { createdBy } = {}) {
  requireObjectBody(body);
  rejectUnexpectedFields(body, new Set([
    "connector",
    "userId",
    "user_id",
    "userid",
    "name",
    "workspaceUrl",
    "endpoint",
    "baseUrl",
    "account",
    "email",
    "botToken",
    "bot_token",
    "token",
    "secret",
    "userToken",
    "user_token",
    "authType",
    "auth",
    "objects",
    "channelIds",
    "channel_ids",
    "historyDays",
    "history_days",
  ]));

  const connector = String(body.connector || "").trim().toLowerCase();
  if (connector !== "slack") {
    throw apiError(400, "VALIDATION_ERROR", `Expected connector "slack", got "${body.connector || ""}".`);
  }

  const authType = String(body.authType || body.auth || "bot_token")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!["bot_token", "api_token", "oauth"].includes(authType)) {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      'Slack registration currently supports authType "bot_token" (bot token + optional user token).'
    );
  }

  const accountRaw = body.account ?? body.email;
  const account = accountRaw === undefined || accountRaw === null || String(accountRaw).trim() === ""
    ? null
    : String(accountRaw).trim().slice(0, 120);

  return {
    id: randomUUID(),
    userId: normalizeUserId(body.userId ?? body.user_id ?? body.userid),
    connector: "slack",
    name: normalizeName(body.name),
    workspaceUrl: normalizeOptionalWorkspaceUrl(
      body.workspaceUrl || body.endpoint || body.baseUrl
    ),
    account,
    botToken: normalizeSlackBotToken(
      body.botToken || body.bot_token || body.token || body.secret
    ),
    userToken: normalizeSlackUserToken(body.userToken || body.user_token),
    authType: "bot_token",
    objects: normalizeObjects(body.objects, SLACK_OBJECTS, "Slack"),
    channelIds: normalizeChannelIds(body.channelIds ?? body.channel_ids),
    historyDays: normalizeHistoryDays(body.historyDays ?? body.history_days),
    ...timestamps(createdBy),
  };
}

function normalizeRequiredString(value, fieldName, { max = 256 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw apiError(400, "VALIDATION_ERROR", `${fieldName} is required.`);
  if (text.length > max) {
    throw apiError(400, "VALIDATION_ERROR", `${fieldName} must be at most ${max} characters.`);
  }
  return text;
}

function normalizeOptionalString(value, fieldName, { max = 256 } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (text.length > max) {
    throw apiError(400, "VALIDATION_ERROR", `${fieldName} must be at most ${max} characters.`);
  }
  return text;
}

function normalizeStringList(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(list)];
}

function normalizeOraclePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw apiError(400, "VALIDATION_ERROR", "port must be an integer between 1 and 65535.");
  }
  return port;
}

function normalizeOraclePageSize(value) {
  if (value === undefined || value === null || value === "") return null;
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100000) {
    throw apiError(400, "VALIDATION_ERROR", "pageSize must be an integer between 1 and 100000.");
  }
  return pageSize;
}

function resolveOracleConnectString(body) {
  const connectString = normalizeOptionalString(
    body.connectString || body.connect_string || body.endpoint,
    "connectString",
    { max: 512 }
  );
  if (connectString) return { connectString, host: null, port: null, serviceName: null, sid: null };

  const host = normalizeOptionalString(body.host, "host", { max: 253 });
  const port = normalizeOraclePort(body.port) ?? 1521;
  const serviceName = normalizeOptionalString(
    body.serviceName || body.service_name,
    "serviceName",
    { max: 128 }
  );
  const sid = normalizeOptionalString(body.sid, "sid", { max: 128 });

  if (host && serviceName) {
    return {
      connectString: `${host}:${port}/${serviceName}`,
      host,
      port,
      serviceName,
      sid: null,
    };
  }
  if (host && sid) {
    return {
      connectString:
        `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(CONNECT_DATA=(SID=${sid})))`,
      host,
      port,
      serviceName: null,
      sid,
    };
  }

  throw apiError(
    400,
    "VALIDATION_ERROR",
    "Provide connectString, or host + serviceName, or host + sid."
  );
}

export function buildOracleConnectionRecord(body = {}, { createdBy } = {}) {
  requireObjectBody(body);
  rejectUnexpectedFields(body, new Set([
    "connector",
    "userId",
    "user_id",
    "userid",
    "name",
    "username",
    "user",
    "password",
    "secret",
    "connectString",
    "connect_string",
    "endpoint",
    "host",
    "port",
    "serviceName",
    "service_name",
    "sid",
    "authType",
    "auth",
    "objects",
    "schemas",
    "schemaName",
    "schema",
    "tableName",
    "table",
    "tablesSpec",
    "tables",
    "pageSize",
    "page_size",
    "modifiedColumn",
    "modified_column",
  ]));

  const connector = String(body.connector || "").trim().toLowerCase();
  if (connector !== "oracle") {
    throw apiError(400, "VALIDATION_ERROR", `Expected connector "oracle", got "${body.connector || ""}".`);
  }

  const authType = String(body.authType || body.auth || "database_credentials")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!["database_credentials", "db_credentials", "password"].includes(authType)) {
    throw apiError(
      400,
      "VALIDATION_ERROR",
      'Oracle registration currently supports authType "database_credentials" only.'
    );
  }

  const username = normalizeRequiredString(body.username || body.user, "username", { max: 128 });
  const password = normalizeRequiredString(body.password || body.secret, "password", { max: 256 });
  const connection = resolveOracleConnectString(body);

  return {
    id: randomUUID(),
    userId: normalizeUserId(body.userId ?? body.user_id ?? body.userid),
    connector: "oracle",
    name: normalizeName(body.name),
    username,
    password,
    connectString: connection.connectString,
    host: connection.host,
    port: connection.port,
    serviceName: connection.serviceName,
    sid: connection.sid,
    authType: "database_credentials",
    objects: normalizeObjects(body.objects, ORACLE_OBJECTS, "Oracle"),
    schemas: normalizeStringList(body.schemas),
    schemaName: normalizeOptionalString(body.schemaName || body.schema, "schemaName", { max: 128 }),
    tableName: normalizeOptionalString(body.tableName || body.table, "tableName", { max: 128 }),
    tablesSpec: normalizeOptionalString(body.tablesSpec || body.tables, "tablesSpec", { max: 2000 }),
    pageSize: normalizeOraclePageSize(body.pageSize ?? body.page_size),
    modifiedColumn: normalizeOptionalString(
      body.modifiedColumn || body.modified_column,
      "modifiedColumn",
      { max: 128 }
    ),
    ...timestamps(createdBy),
  };
}

export function buildConnectionRecord(body = {}, options = {}) {
  requireObjectBody(body);
  const connector = String(body.connector || "").trim().toLowerCase();
  if (connector === "jira") return buildJiraConnectionRecord(body, options);
  if (connector === "slack") return buildSlackConnectionRecord(body, options);
  if (connector === "oracle") return buildOracleConnectionRecord(body, options);
  throw apiError(
    400,
    "VALIDATION_ERROR",
    `Unsupported connector "${body.connector || ""}". Supported: ${supportedConnectors().join(", ")}`
  );
}

export async function createConnection(database, body, options = {}) {
  const record = buildConnectionRecord(body, options);
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
