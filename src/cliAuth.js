import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_PATH = path.resolve("data/cli-session.json");
const DEFAULT_SESSION_HOURS = 12;

/**
 * Basic CLI gate for QA.
 * Login once with APP_AUTH_USER / APP_AUTH_PASSWORD, then connector commands
 * reuse data/cli-session.json until it expires or logout runs.
 */
export async function loginCli(argv) {
  const expectedUser = process.env.APP_AUTH_USER?.trim() || "";
  const expectedPassword = process.env.APP_AUTH_PASSWORD ?? "";
  if (!expectedUser || !expectedPassword) {
    throw new Error(
      "CLI auth is required. Set APP_AUTH_USER and APP_AUTH_PASSWORD in .env, then run: npm run login -- --user qa --password secret"
    );
  }

  const provided = readCliCredentials(argv);
  if (!provided.user || provided.password == null || provided.password === "") {
    throw new Error(
      "Missing login credentials. Example: npm run login -- --user qa --password secret"
    );
  }

  const userOk = secretsMatch(provided.user, expectedUser);
  const passwordOk = secretsMatch(provided.password, expectedPassword);
  if (!userOk || !passwordOk) {
    throw new Error("CLI login failed. Check --user and --password against APP_AUTH_USER and APP_AUTH_PASSWORD in .env.");
  }

  const hours = sessionHours();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const session = {
    user: provided.user,
    token: randomBytes(24).toString("hex"),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await mkdir(path.dirname(SESSION_PATH), { recursive: true });
  await writeFile(SESSION_PATH, JSON.stringify(session, null, 2), "utf8");
  return {
    user: session.user,
    expiresAt: session.expiresAt,
    hours,
  };
}

export async function logoutCli() {
  try {
    await unlink(SESSION_PATH);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function requireCliAuth() {
  const expectedUser = process.env.APP_AUTH_USER?.trim() || "";
  const expectedPassword = process.env.APP_AUTH_PASSWORD ?? "";
  if (!expectedUser || !expectedPassword) {
    throw new Error(
      "CLI auth is required. Set APP_AUTH_USER and APP_AUTH_PASSWORD in .env, then run: npm run login -- --user qa --password secret"
    );
  }

  const session = await loadSession();
  if (!session) {
    throw new Error(
      "Not logged in. Run once: npm run login -- --user qa --password secret"
    );
  }

  const expiresAt = Date.parse(session.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await logoutCli().catch(() => {});
    throw new Error(
      "CLI session expired. Run again: npm run login -- --user qa --password secret"
    );
  }

  if (!secretsMatch(String(session.user || ""), expectedUser)) {
    await logoutCli().catch(() => {});
    throw new Error(
      "CLI session user no longer matches APP_AUTH_USER. Run: npm run login -- --user qa --password secret"
    );
  }

  return {
    user: session.user,
    expiresAt: session.expiresAt,
  };
}

async function loadSession() {
  try {
    const raw = await readFile(SESSION_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readCliCredentials(argv) {
  let user = "";
  let password = "";
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if ((key === "--user" || key === "--username") && value != null && !String(value).startsWith("--")) {
      user = String(value);
      i += 1;
    } else if ((key === "--password" || key === "--pass") && value != null && !String(value).startsWith("--")) {
      password = String(value);
      i += 1;
    }
  }
  return { user, password };
}

function sessionHours() {
  const value = Number(process.env.APP_AUTH_SESSION_HOURS || DEFAULT_SESSION_HOURS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SESSION_HOURS;
  return Math.min(value, 168);
}

function secretsMatch(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}
