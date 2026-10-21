import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USERS_PATH = path.resolve("data/rbac-users.json");
const EXAMPLE_PATH = new URL("./rbac-users.example.json", import.meta.url);

const ROLES = new Set(["viewer", "editor"]);

export async function ensureUsersFile() {
  try {
    await access(USERS_PATH);
  } catch {
    await mkdir(path.dirname(USERS_PATH), { recursive: true });
    await copyFile(EXAMPLE_PATH, USERS_PATH);
  }
  await migratePlaintextPasswords();
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
  return role === "viewer" || role === "editor";
}

export function canEdit(role) {
  return role === "editor";
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

async function migratePlaintextPasswords() {
  const raw = await readFile(USERS_PATH, "utf8");
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) return;

  let changed = false;
  const migrated = users.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.passwordHash && entry.passwordSalt && !entry.password) return entry;
    if (entry.password == null || entry.password === "") return entry;
    const hashed = hashPassword(entry.password);
    changed = true;
    return {
      username: entry.username,
      role: entry.role,
      passwordSalt: hashed.passwordSalt,
      passwordHash: hashed.passwordHash,
    };
  });

  if (changed) {
    await writeFile(USERS_PATH, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    console.log("[settings] migrated plaintext passwords to scrypt hashes in data/rbac-users.json");
  }
}

function normalizeUser(entry) {
  if (!entry || typeof entry !== "object") return null;
  const username = String(entry.username || "").trim();
  const role = String(entry.role || "").trim().toLowerCase();
  if (!username || !ROLES.has(role)) return null;

  if (entry.passwordHash && entry.passwordSalt) {
    return {
      username,
      role,
      passwordSalt: String(entry.passwordSalt),
      passwordHash: String(entry.passwordHash),
    };
  }

  // Allow one-read of plaintext during migration path
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
