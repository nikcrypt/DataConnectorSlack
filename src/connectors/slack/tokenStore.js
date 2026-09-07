import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TOKEN_PATH = path.resolve("data/slack-auth.json");

/**
 * Persist Slack OAuth install result locally.
 * For production, use a secrets manager instead of a JSON file.
 */
export async function loadSlackAuth() {
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveSlackAuth(auth) {
  await mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  const safe = {
    ok: true,
    accessToken: auth.accessToken,
    tokenType: auth.tokenType || "bot",
    scope: auth.scope || "",
    botUserId: auth.botUserId || null,
    appId: auth.appId || null,
    team: auth.team || null,
    installedAt: auth.installedAt || new Date().toISOString(),
  };
  await writeFile(TOKEN_PATH, JSON.stringify(safe, null, 2), "utf8");
  return safe;
}

export function getBotTokenFromEnvOrAuth(auth) {
  if (process.env.SLACK_BOT_TOKEN?.startsWith("xoxb-")) {
    return process.env.SLACK_BOT_TOKEN;
  }
  if (auth?.accessToken?.startsWith("xoxb-")) {
    return auth.accessToken;
  }
  return null;
}
