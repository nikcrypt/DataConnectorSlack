import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USERS_PATH = path.resolve("data/rbac-users.json");
const EXAMPLE_PATH = new URL("./rbac-users.example.json", import.meta.url);

const ROLES = new Set(["viewer", "admin"]);
const SALT_RE = /^[a-f0-9]{32}$/i;
const HASH_RE = /^[a-f0-9]{128}$/i;

export function isValidEmail(value) {
  if (typeof value !== "string") return false;
  const email = value.trim();
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function areValidPermissions(value) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") return false;
    const permission = entry.trim();
    if (!permission || seen.has(permission)) return false;
    seen.add(permission);
  }
  return true;
}

export async function ensureUsersFile() {
  try {
    await access(USERS_PATH);
  } catch {
    await mkdir(path.dirname(USERS_PATH), { recursive: true });
    await copyFile(EXAMPLE_PATH, USERS_PATH);
  }
  await migrateUsersFile(USERS_PATH);
  return USERS_PATH;
}

/**
 * Load local accounts.
 * - Settings (default): initialize file if missing, migrate legacy hashes.
 * - API: `loadUsers({ initialize: false, filePath })` — read-only, strict validation.
 */
export async function loadUsers(options = {}) {
  const initialize = options.initialize !== false;
  const filePath = options.filePath ? path.resolve(options.filePath) : USERS_PATH;

  if (initialize) {
    if (filePath === USERS_PATH) {
      await ensureUsersFile();
    } else {
      await migrateUsersFile(filePath);
    }
    const raw = await readFile(filePath, "utf8");
    const users = JSON.parse(raw);
    if (!Array.isArray(users)) throw new Error("rbac-users.json must be an array");
    return users.map((entry) => normalizeUser(entry, { strict: false })).filter(Boolean);
  }

  return loadUsersStrict(filePath);
}

export async function authenticate(usernameOrEmail, password, options = {}) {
  const users = options.users || await loadUsers();
  const loginField = options.loginField === "email" ? "email" : "username";
  const want = String(usernameOrEmail || "").trim();
  let user = null;

  if (loginField === "email") {
    const email = want.toLowerCase();
    if (!isValidEmail(email)) return null;
    // Dummy verify when missing so timing is closer for unknown emails.
    user = users.find((item) => item.email && item.email.toLowerCase() === email) || null;
    if (!user) {
      verifyPassword(String(password ?? ""), "0".repeat(32), "0".repeat(128));
      return null;
    }
  } else {
    user = users.find((item) => secretsMatch(item.username, want)) || null;
    if (!user) return null;
  }

  if (!verifyPassword(String(password ?? ""), user.passwordSalt, user.passwordHash)) {
    return null;
  }

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    email: user.email || null,
    role: user.role,
    permissions: [...(user.permissions || [])],
  };
}

export function canView(role) {
  return role === "viewer" || role === "admin";
}

/** Admin can edit connector settings (JSON config). */
export function canEdit(role) {
  return role === "admin";
}

/** Viewer and admin can run full/incremental extracts. */
export function canRunExtract(role) {
  return role === "viewer" || role === "admin";
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const passwordHash = scryptSync(String(password), salt, 64).toString("hex");
  return { passwordSalt: salt, passwordHash };
}

function verifyPassword(password, salt, passwordHash) {
  if (!salt || !passwordHash) return false;
  try {
    const next = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(passwordHash, "hex");
    if (next.length !== expected.length) return false;
    return timingSafeEqual(next, expected);
  } catch {
    return false;
  }
}

async function loadUsersStrict(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Users file is missing.");
    }
    throw error;
  }

  let users;
  try {
    users = JSON.parse(raw);
  } catch {
    throw new Error("Users file contains invalid JSON.");
  }
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("Users file must be a non-empty array.");
  }

  const usernames = new Set();
  const emails = new Set();
  const normalized = [];

  for (const entry of users) {
    const user = normalizeUser(entry, { strict: true });
    if (!user) {
      throw new Error("Users file contains an invalid account.");
    }
    const usernameKey = user.username.toLowerCase();
    if (usernames.has(usernameKey)) {
      throw new Error("Users file contains duplicate usernames.");
    }
    usernames.add(usernameKey);
    if (user.email) {
      const emailKey = user.email.toLowerCase();
      if (emails.has(emailKey)) {
        throw new Error("Users file contains duplicate emails.");
      }
      emails.add(emailKey);
    }
    normalized.push(user);
  }

  return normalized;
}

async function migrateUsersFile(filePath = USERS_PATH) {
  const raw = await readFile(filePath, "utf8");
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) return;

  let changed = false;
  const migrated = users.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    let next = { ...entry };

    if (String(next.role || "").toLowerCase() === "editor") {
      next.role = "admin";
      changed = true;
    }
    if (String(next.username || "").trim().toLowerCase() === "editor") {
      next.username = "admin";
      changed = true;
    }

    if (next.passwordHash && next.passwordSalt && (next.password == null || next.password === "")) {
      return preserveProfile(next, {
        username: next.username,
        role: next.role,
        passwordSalt: next.passwordSalt,
        passwordHash: next.passwordHash,
      });
    }

    if (next.password != null && next.password !== "") {
      const hashed = hashPassword(next.password);
      changed = true;
      return preserveProfile(next, {
        username: next.username,
        role: next.role,
        passwordSalt: hashed.passwordSalt,
        passwordHash: hashed.passwordHash,
      });
    }

    return next;
  });

  if (changed) {
    await writeFile(filePath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    if (filePath === USERS_PATH) {
      console.log("[settings] migrated rbac users (editor→admin / password hashes) in data/rbac-users.json");
    }
  }
}

function preserveProfile(source, base) {
  const out = { ...base };
  if (source.email != null && String(source.email).trim()) {
    out.email = String(source.email).trim().toLowerCase();
  }
  if (source.displayName != null && String(source.displayName).trim()) {
    out.displayName = String(source.displayName).trim();
  }
  if (Array.isArray(source.permissions)) {
    out.permissions = normalizePermissions(source.permissions);
  }
  return out;
}

function normalizePermissions(value) {
  if (!areValidPermissions(value)) {
    throw new Error("Invalid permissions list.");
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function normalizeUser(entry, { strict }) {
  if (!entry || typeof entry !== "object") return null;
  let username = String(entry.username || "").trim();
  let role = String(entry.role || "").trim().toLowerCase();
  if (role === "editor") role = "admin";
  if (username.toLowerCase() === "editor") username = "admin";
  if (!username || !ROLES.has(role)) return null;

  if (strict) {
    if (entry.password != null && entry.password !== "") return null;
    if (!SALT_RE.test(String(entry.passwordSalt || ""))) return null;
    if (!HASH_RE.test(String(entry.passwordHash || ""))) return null;
  }

  let email = null;
  if (entry.email != null && String(entry.email).trim()) {
    email = String(entry.email).trim().toLowerCase();
    if (!isValidEmail(email)) {
      if (strict) return null;
      email = null;
    }
  }

  let displayName = username;
  if (entry.displayName != null && String(entry.displayName).trim()) {
    displayName = String(entry.displayName).trim();
  }

  let permissions = [];
  if (entry.permissions !== undefined && entry.permissions !== null) {
    if (!areValidPermissions(entry.permissions)) {
      if (strict) return null;
      permissions = [];
    } else {
      permissions = normalizePermissions(entry.permissions);
    }
  } else if (!strict) {
    permissions = defaultPermissions(role);
  }

  if (entry.passwordHash && entry.passwordSalt) {
    return {
      username,
      role,
      email,
      displayName,
      permissions,
      passwordSalt: String(entry.passwordSalt),
      passwordHash: String(entry.passwordHash),
    };
  }

  if (!strict && entry.password != null && entry.password !== "") {
    const hashed = hashPassword(entry.password);
    return {
      username,
      role,
      email,
      displayName,
      permissions,
      passwordSalt: hashed.passwordSalt,
      passwordHash: hashed.passwordHash,
    };
  }

  return null;
}

function defaultPermissions(role) {
  if (role === "admin") {
    return [
      "workspace.view",
      "connectors.read",
      "connectors.configure",
      "extractions.run",
    ];
  }
  if (role === "viewer") {
    return ["workspace.view", "connectors.read", "extractions.run"];
  }
  return [];
}

function secretsMatch(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}
