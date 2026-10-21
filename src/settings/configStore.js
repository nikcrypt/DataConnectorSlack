import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_DIR = path.resolve("src/config/connectors");

export async function listConnectors() {
  const names = await readdir(CONFIG_DIR);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/i, ""))
    .sort();
}

export async function readConnectorConfig(key) {
  const filePath = resolveConfigPath(key);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function writeConnectorConfig(key, config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw Object.assign(new Error("Config must be a JSON object"), { status: 400 });
  }
  const filePath = resolveConfigPath(key);
  // Ensure file already exists — do not create arbitrary new connectors via UI
  await readFile(filePath, "utf8");
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(filePath, body, "utf8");
  return config;
}

function resolveConfigPath(key) {
  const safe = String(key || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(safe)) {
    throw Object.assign(new Error("Invalid connector key"), { status: 400 });
  }
  return path.join(CONFIG_DIR, `${safe}.json`);
}
