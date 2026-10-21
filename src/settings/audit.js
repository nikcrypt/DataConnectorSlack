import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const AUDIT_PATH = path.resolve("data/settings-audit.jsonl");

export async function appendAudit(entry) {
  await mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  const row = {
    at: new Date().toISOString(),
    ...entry,
  };
  await appendFile(AUDIT_PATH, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export async function listAudit({ limit = 50 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    const raw = await readFile(AUDIT_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const items = [];
    for (let i = lines.length - 1; i >= 0 && items.length < max; i -= 1) {
      try {
        items.push(JSON.parse(lines[i]));
      } catch {
        /* skip bad lines */
      }
    }
    return items;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
