import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { areValidPermissions, canView, isValidEmail } from "../../settings/rbac.js";

export async function createSessionStore({ sessionTtlMs, sessionsFile }) {
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > 86400000) {
    throw new Error("Invalid API session lifetime.");
  }

  if (typeof sessionsFile !== "string" || !sessionsFile.trim()) {
    throw new Error("API session file is required.");
  }

  let closed = false;
  let pending = Promise.resolve();

  async function readSessions() {
    let raw;
    try {
      raw = await readFile(sessionsFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    let sessions;
    try {
      sessions = JSON.parse(raw);
    } catch {
      throw new Error("API session file contains invalid JSON.");
    }
    const hashes = new Set();
    if (!Array.isArray(sessions) || sessions.some((session) => {
      if (!session || typeof session.tokenHash !== "string"
        || !/^[a-f0-9]{64}$/.test(session.tokenHash)
        || typeof session.username !== "string" || !session.username.trim()
        || (session.displayName !== undefined && typeof session.displayName !== "string")
        || (session.email != null && !isValidEmail(session.email))
        || (session.permissions !== undefined && !areValidPermissions(session.permissions))
        || !canView(session.role) || !Number.isSafeInteger(session.expiresAt)
        || session.expiresAt <= 0 || hashes.has(session.tokenHash)) return true;
      hashes.add(session.tokenHash);
      return false;
    })) {
      throw new Error("API session file contains invalid session records.");
    }
    // Username-only API sessions predate email login and must sign in again.
    return sessions.filter((session) => isValidEmail(session.email));
  }

  async function saveSessions(sessions) {
    const temporaryFile = `${sessionsFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryFile, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporaryFile, sessionsFile);
    } finally {
      await unlink(temporaryFile).catch(() => {});
    }
  }

  // One process owns this file; serialize requests so they cannot overwrite each other.
  function runOperation(operation) {
    if (closed) return Promise.reject(new Error("API session store is closed."));
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  await mkdir(path.dirname(sessionsFile), { recursive: true, mode: 0o700 });
  const initialSessions = await readSessions();
  await saveSessions(initialSessions.filter((session) => session.expiresAt > Date.now()));

  function createSession(user) {
    return runOperation(async () => {
      if (!user || typeof user.username !== "string" || !user.username.trim()
        || (user.displayName !== undefined && typeof user.displayName !== "string")
        || !isValidEmail(user.email) || !canView(user.role)
        || (user.permissions !== undefined && !areValidPermissions(user.permissions))) {
        throw new Error("A verified local user is required to create an API session.");
      }
      const sessions = (await readSessions()).filter((session) => session.expiresAt > Date.now());
      const token = randomBytes(24).toString("hex");
      const session = {
        username: user.username,
        displayName: (user.displayName || "").trim() || user.username,
        email: user.email.trim().toLowerCase(),
        role: user.role,
        permissions: [...(user.permissions ?? [])],
        expiresAt: Date.now() + sessionTtlMs,
      };
      sessions.push({ tokenHash: hashToken(token), ...session });
      await saveSessions(sessions);
      return { token, ...session };
    });
  }

  function getSession(token) {
    return runOperation(async () => {
      if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) return null;
      const tokenHash = hashToken(token);
      const sessions = await readSessions();
      const session = sessions.find((entry) => entry.tokenHash === tokenHash);
      if (!session || session.expiresAt <= Date.now()) return null;
      return {
        username: session.username,
        displayName: (session.displayName || "").trim() || session.username,
        email: session.email,
        role: session.role,
        permissions: [...(session.permissions ?? [])],
        expiresAt: session.expiresAt,
      };
    });
  }

  function destroySession(token) {
    return runOperation(async () => {
      if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) return;
      const tokenHash = hashToken(token);
      const sessions = await readSessions();
      await saveSessions(sessions.filter((session) => session.tokenHash !== tokenHash && session.expiresAt > Date.now()));
    });
  }

  async function close() {
    closed = true;
    await pending;
  }

  return { createSession, getSession, destroySession, close };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
