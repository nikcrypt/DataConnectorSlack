import { randomBytes } from "node:crypto";

const sessions = new Map();
const DEFAULT_HOURS = 12;

export function createSession(user) {
  const token = randomBytes(24).toString("hex");
  const hours = Number(process.env.SETTINGS_SESSION_HOURS || DEFAULT_HOURS);
  const ttlMs = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS) * 60 * 60 * 1000;
  const session = {
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + ttlMs,
  };
  sessions.set(token, session);
  return { token, ...session };
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}
