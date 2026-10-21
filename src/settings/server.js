import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit, listAudit } from "./audit.js";
import {
  listConnectors,
  readConnectorConfig,
  writeConnectorConfig,
} from "./configStore.js";
import { createExtraction, getExtraction, phase2BaseUrl } from "./extractClient.js";
import { authenticate, canEdit, canView, ensureUsersFile } from "./rbac.js";
import { createSession, destroySession, getSession } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const port = Number(process.env.SETTINGS_PORT || 3080);

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return getSession(cookies.settings_session || "");
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function setSessionCookie(token) {
  return `settings_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`;
}

function clearSessionCookie() {
  return "settings_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

async function serveStatic(urlPath, res) {
  const relative = urlPath === "/" ? "/index.html" : urlPath;
  const safe = path.normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const type =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "text/javascript; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function requireAuth(req, res, { edit = false } = {}) {
  const session = sessionFromRequest(req);
  if (!session || !canView(session.role)) {
    sendJson(res, 401, { error: "Login required" });
    return null;
  }
  if (edit && !canEdit(session.role)) {
    sendJson(res, 403, { error: "Editor role required" });
    return null;
  }
  return session;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "settings",
      phase2Api: phase2BaseUrl(),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    const user = await authenticate(body.username, body.password);
    if (!user) {
      await appendAudit({
        action: "login_failed",
        username: String(body.username || ""),
      }).catch(() => {});
      return sendJson(res, 401, { error: "Invalid username or password" });
    }
    const session = createSession(user);
    await appendAudit({
      action: "login",
      username: session.username,
      role: session.role,
    });
    return sendJson(
      res,
      200,
      { username: session.username, role: session.role },
      { "Set-Cookie": setSessionCookie(session.token) }
    );
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const cookies = parseCookies(req.headers.cookie);
    const session = getSession(cookies.settings_session || "");
    destroySession(cookies.settings_session || "");
    if (session) {
      await appendAudit({
        action: "logout",
        username: session.username,
        role: session.role,
      });
    }
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = sessionFromRequest(req);
    if (!session) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { username: session.username, role: session.role });
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    const session = await requireAuth(req, res);
    if (!session) return;
    const limit = Number(url.searchParams.get("limit") || 50);
    const items = await listAudit({ limit });
    return sendJson(res, 200, { items });
  }

  if (req.method === "GET" && url.pathname === "/api/connectors") {
    const session = await requireAuth(req, res);
    if (!session) return;
    const keys = await listConnectors();
    return sendJson(res, 200, {
      role: session.role,
      canEdit: canEdit(session.role),
      connectors: keys,
      phase2Api: phase2BaseUrl(),
    });
  }

  const extractMatch = url.pathname.match(
    /^\/api\/connectors\/([a-z0-9_-]+)\/extract$/i
  );
  if (extractMatch && req.method === "POST") {
    const session = await requireAuth(req, res, { edit: true });
    if (!session) return;
    const key = extractMatch[1].toLowerCase();
    const body = await readJson(req);
    const objects = Array.isArray(body.objects)
      ? body.objects.map((item) => String(item).trim()).filter(Boolean)
      : String(body.objects || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const mode = body.mode === "incremental" ? "incremental" : "full";
    try {
      // Ensure config exists before queuing
      await readConnectorConfig(key);
      const created = await createExtraction({
        connectorKey: key,
        objects,
        mode,
        requestedBy: session.username,
        params: body.params && typeof body.params === "object" ? body.params : {},
      });
      await appendAudit({
        action: "extract_run",
        username: session.username,
        role: session.role,
        connector: key,
        mode,
        objects,
        requestId: created.request_id,
      });
      return sendJson(res, 202, created);
    } catch (error) {
      await appendAudit({
        action: "extract_run_failed",
        username: session.username,
        role: session.role,
        connector: key,
        error: error.message,
      }).catch(() => {});
      return sendJson(res, error.status || 500, { error: error.message });
    }
  }

  const jobMatch = url.pathname.match(/^\/api\/extractions\/([0-9a-f-]{36})$/i);
  if (jobMatch && req.method === "GET") {
    const session = await requireAuth(req, res);
    if (!session) return;
    try {
      const job = await getExtraction(jobMatch[1]);
      return sendJson(res, 200, job);
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message });
    }
  }

  const one = url.pathname.match(/^\/api\/connectors\/([a-z0-9_-]+)$/i);
  if (one && req.method === "GET") {
    const session = await requireAuth(req, res);
    if (!session) return;
    try {
      const config = await readConnectorConfig(one[1]);
      return sendJson(res, 200, {
        key: one[1].toLowerCase(),
        canEdit: canEdit(session.role),
        config,
      });
    } catch (error) {
      if (error.code === "ENOENT") return sendJson(res, 404, { error: "Connector config not found" });
      throw error;
    }
  }

  if (one && req.method === "PUT") {
    const session = await requireAuth(req, res, { edit: true });
    if (!session) return;
    const body = await readJson(req);
    const config = body.config !== undefined ? body.config : body;
    try {
      const before = await readConnectorConfig(one[1]).catch(() => null);
      const saved = await writeConnectorConfig(one[1], config);
      await appendAudit({
        action: "config_save",
        username: session.username,
        role: session.role,
        connector: one[1].toLowerCase(),
        beforeKeys: before ? Object.keys(before) : [],
        afterKeys: Object.keys(saved),
      });
      return sendJson(res, 200, {
        key: one[1].toLowerCase(),
        config: saved,
        savedBy: session.username,
      });
    } catch (error) {
      if (error.status) return sendJson(res, error.status, { error: error.message });
      if (error.code === "ENOENT") return sendJson(res, 404, { error: "Connector config not found" });
      if (error instanceof SyntaxError) return sendJson(res, 400, { error: "Invalid JSON" });
      throw error;
    }
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    return await serveStatic(url.pathname, res);
  } catch (error) {
    console.error("[settings]", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || "Server error" });
    }
  }
}

async function main() {
  await ensureUsersFile();
  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.listen(port, () => {
    console.log(`[settings] open http://localhost:${port}`);
    console.log(`[settings] Phase 2 API: ${phase2BaseUrl()}`);
    console.log("[settings] demo users (passwords hashed on disk):");
    console.log("  viewer / viewer123  → view only");
    console.log("  editor / editor123  → view + edit + run extract");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
