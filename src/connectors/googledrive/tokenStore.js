import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TOKEN_PATH = path.resolve("data/google-auth.json");

export async function loadGoogleAuth() {
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveGoogleAuth(auth) {
  await mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  const safe = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    scope: auth.scope || "",
    expiresAt: auth.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(TOKEN_PATH, JSON.stringify(safe, null, 2), "utf8");
  return safe;
}
