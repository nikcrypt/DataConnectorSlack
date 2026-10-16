import "dotenv/config";
import { SlackClient } from "./SlackClient.js";
import { getBotTokenFromEnvOrAuth, loadSlackAuth } from "./tokenStore.js";

const DEFAULT_COUNT = 200;

function parseArgs(argv) {
  const args = { count: DEFAULT_COUNT, channel: "", delayMs: 1100 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--count" && value) args.count = Number(value);
    else if (key === "--channel" && value) args.channel = value.trim();
    else if (key === "--delay-ms" && value) args.delayMs = Number(value);
    else continue;
    i += 1;
  }
  return args;
}

function channelHint() {
  return process.env.SLACK_SEED_CHANNEL
    || process.env.SLACK_CHANNEL_IDS?.split(",").map((value) => value.trim()).filter(Boolean)[0]
    || "";
}

async function resolveChannel(client, channel) {
  if (/^[CG][A-Z0-9]+$/.test(channel)) return channel;
  const name = channel.replace(/^#/, "").toLowerCase();
  const visible = [];
  for await (const item of client.paginate("conversations.list", "channels", {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200,
  })) {
    visible.push(item.name);
    if (item.name === name) return item.id;
  }
  const close = visible.filter((item) => item.includes(name) || name.includes(item));
  const hint = close.length
    ? ` Closest match: ${close.map((item) => `#${item}`).join(", ")}.`
    : ` Channels this bot can see: ${visible.map((item) => `#${item}`).join(", ") || "none"}.`;
  throw new Error(`Slack channel not found: ${channel}.${hint} Invite the bot into the channel, then rerun.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Number.isInteger(args.count) || args.count < 1) {
    throw new Error("--count must be a positive integer");
  }
  if (!Number.isInteger(args.delayMs) || args.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }

  const auth = await loadSlackAuth();
  const token = getBotTokenFromEnvOrAuth(auth);
  if (!token) {
    throw new Error("Missing SLACK_BOT_TOKEN. Set it in .env or run: npm run auth");
  }

  const requested = args.channel || channelHint();
  if (!requested) {
    throw new Error("Missing channel. Set SLACK_SEED_CHANNEL or pass --channel #general");
  }

  const client = new SlackClient(token);
  const channelId = await resolveChannel(client, requested);
  try {
    await client.call("conversations.join", { channel: channelId });
  } catch (error) {
    if (error.code !== "missing_scope" && error.code !== "method_not_supported_for_channel_type") {
      if (!String(error.message).includes("already_in_channel")) throw error;
    }
  }

  const batch = new Date().toISOString();
  console.log(`[slack-seed] posting ${args.count} messages to ${channelId}`);
  for (let index = 1; index <= args.count; index += 1) {
    await client.call("chat.postMessage", {
      channel: channelId,
      text: `Data connector test ${batch} message ${index} of ${args.count}`,
    });
    if (index % 25 === 0 || index === args.count) {
      console.log(`[slack-seed] posted ${index} of ${args.count}`);
    }
    if (index < args.count && args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }
  console.log("[slack-seed] done. Run npm run extract:slack:mongo or the incremental command.");
}

main().catch((error) => {
  const message = String(error.message || error);
  if (message.includes("missing_scope") && message.includes("chat.postMessage")) {
    console.error(
      "Error: the Slack bot cannot post yet. In api.slack.com add the bot scope chat:write, reinstall the app on dataconnect-talk, and update SLACK_BOT_TOKEN."
    );
  } else if (message.includes("not_in_channel")) {
    console.error("Error: invite the bot into the channel with /invite @YourBot, then run this script again.");
  } else {
    console.error("Error:", message);
  }
  process.exitCode = 1;
});
