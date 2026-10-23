import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USERS_PATH = path.resolve("data/rbac-users.json");
const EXAMPLE_PATH = new URL("./rbac-users.example.json", import.meta.url);

const ROLES = new Set(["viewer", "admin"]);

export async function ensureUsersFile() {
  try {
    await access(USERS_PATH);
  } catch {
    await mkdir(path.dirname(USERS_PATH), { recursive: true });
    await copyFile(EXAMPLE_PATH, USERS_PATH);
  }
  await migrateUsersFile();
  return USERS_PATH;
}

export async function loadUsers() {
  await ensureUsersFile();
  const raw = await readFile(USERS_PATH, "utf8");
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) throw new Error("rbac-users.json must be an array");
  return users.map(normalizeUser).filter(Boolean);
}

export async function authenticate(username, password) {
  const users = await loadUsers();
  const want = String(username || "").trim();
  const user = users.find((item) => secretsMatch(item.username, want));
  if (!user) return null;
  if (!verifyPassword(String(password ?? ""), user.passwordSalt, user.passwordHash)) {
    return null;
  }
  return { username: user.username, role: user.role };
}

export function canView(role) {
  return role === "viewer" || role === "admin";
}

/** Admin can edit config and run extracts. */
export function canEdit(role) {
  return role === "admin";
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

async function migrateUsersFile() {
  const raw = await readFile(USERS_PATH, "utf8");
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) return;

  let changed = false;
  const migrated = users.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    let next = { ...entry };

    // Rename legacy editor role / username → admin
    if (String(next.role || "").toLowerCase() === "editor") {
      next.role = "admin";
      changed = true;
    }
    if (String(next.username || "").trim().toLowerCase() === "editor") {
      next.username = "admin";
      changed = true;
    }

    if (next.passwordHash && next.passwordSalt && (next.password == null || next.password === "")) {
      return {
        username: next.username,
        role: next.role,
        passwordSalt: next.passwordSalt,
        passwordHash: next.passwordHash,
      };
    }

    if (next.password != null && next.password !== "") {
      const hashed = hashPassword(next.password);
      changed = true;
      return {
        username: next.username,
        role: next.role,
        passwordSalt: hashed.passwordSalt,
        passwordHash: hashed.passwordHash,
      };
    }

    return next;
  });

  if (changed) {
    await writeFile(USERS_PATH, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    console.log("[settings] migrated rbac users (editor→admin / password hashes) in data/rbac-users.json");
  }
}

function normalizeUser(entry) {
  if (!entry || typeof entry !== "object") return null;
  let username = String(entry.username || "").trim();
  let role = String(entry.role || "").trim().toLowerCase();
  if (role === "editor") role = "admin";
  if (username.toLowerCase() === "editor") username = "admin";
  if (!username || !ROLES.has(role)) return null;

  if (entry.passwordHash && entry.passwordSalt) {
    return {
      username,
      role,
      passwordSalt: String(entry.passwordSalt),
      passwordHash: String(entry.passwordHash),
    };
  }

  if (entry.password != null && entry.password !== "") {
    const hashed = hashPassword(entry.password);
    return {
      username,
      role,
      passwordSalt: hashed.passwordSalt,
      passwordHash: hashed.passwordHash,
    };
  }

  return null;
}

function secretsMatch(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}
