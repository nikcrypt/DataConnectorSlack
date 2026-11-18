import { isIP } from "node:net";
import path from "node:path";

function readPositiveInteger(env, name, fallback, max) {
  const text = (env[name] ?? String(fallback)).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}.`);
  }
  return value;
}

function readCorsOrigins(value = "") {
  if (!value.trim()) return [];

  return [...new Set(value.split(",").map((entry) => {
    const origin = entry.trim();
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("API_CORS_ORIGINS must contain comma-separated HTTP or HTTPS origins.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error("API_CORS_ORIGINS must contain origins only, without paths, credentials or wildcards.");
    }
    return origin;
  }))];
}

export function loadApiConfig(env = process.env) {
  const host = (env.API_HOST ?? "127.0.0.1").trim();

  if (host !== "localhost" && isIP(host) === 0) {
    throw new Error("API_HOST must be an IP address or localhost.");
  }

  return {
    host,
    port: readPositiveInteger(env, "API_PORT", 3081, 65535),
    corsOrigins: readCorsOrigins(env.API_CORS_ORIGINS),
    bodyLimitBytes: readPositiveInteger(env, "API_BODY_LIMIT_BYTES", 102400, 10485760),
    rateLimitWindowMs: readPositiveInteger(env, "API_RATE_LIMIT_WINDOW_MS", 60000, 3600000),
    rateLimitMax: readPositiveInteger(env, "API_RATE_LIMIT_MAX", 100, 100000),
    requestTimeoutMs: readPositiveInteger(env, "API_REQUEST_TIMEOUT_MS", 30000, 300000),
  };
}

export function loadAuthConfig(env = process.env) {
  const usersFile = (env.API_AUTH_USERS_FILE ?? "data/rbac-users.json").trim();
  if (!usersFile) throw new Error("API_AUTH_USERS_FILE must not be empty.");
  const sessionsFile = (env.API_SESSION_FILE ?? "data/api-sessions.json").trim();
  if (!sessionsFile) throw new Error("API_SESSION_FILE must not be empty.");
  if (path.resolve(usersFile).toLowerCase() === path.resolve(sessionsFile).toLowerCase()) {
    throw new Error("API_SESSION_FILE must be different from API_AUTH_USERS_FILE.");
  }

  const secureText = (env.API_SESSION_COOKIE_SECURE ?? "false").trim();
  if (secureText !== "true" && secureText !== "false") {
    throw new Error("API_SESSION_COOKIE_SECURE must be true or false.");
  }

  const sessionTtlMs = readPositiveInteger(env, "API_SESSION_TTL_SECONDS", 43200, 86400) * 1000;
  return {
    usersFile: path.resolve(usersFile),
    sessionsFile: path.resolve(sessionsFile),
    sessionTtlMs,
    loginRateLimitWindowMs: readPositiveInteger(env, "API_LOGIN_RATE_LIMIT_WINDOW_MS", 900000, 3600000),
    loginRateLimitMax: readPositiveInteger(env, "API_LOGIN_RATE_LIMIT_MAX", 10, 1000),
    cookieName: "connector_api_session",
    cookieOptions: {
      httpOnly: true,
      secure: secureText === "true",
      sameSite: "lax",
      path: "/api/v1",
      maxAge: sessionTtlMs,
    },
  };
}
