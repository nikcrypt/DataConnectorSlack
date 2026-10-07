import { createHash } from "node:crypto";
import { DataConnector } from "../connectors/base/DataConnector.js";

const OBJECTS = ["users", "channels", "messages"];

/**
 * In-process Slack stand-in for benchmarks.
 * Yields the same record contract as SlackConnector, with no network calls.
 * Optional per-page delay models waiting on the Slack Web API.
 */
export class SampleSlackConnector extends DataConnector {
  /**
   * @param {{
   *   users?: number,
   *   channels?: number,
   *   messages?: number,
   *   shardIndex?: number,
   *   shardCount?: number,
   *   pageSize?: number,
   *   delayMs?: number,
   *   logPages?: boolean,
   *   connectorKey?: string,
   *   stopAfter?: number,
   * }} [options]
   */
  constructor(options = {}) {
    super();
    this.userCount = options.users ?? 500;
    this.channelCount = options.channels ?? 100;
    this.messageCount = options.messages ?? 20_000;
    this.shardIndex = options.shardIndex ?? 0;
    this.shardCount = options.shardCount ?? 1;
    this.pageSize = options.pageSize ?? 200;
    this.delayMs = options.delayMs ?? 0;
    this.logPages = Boolean(options.logPages);
    this.connectorKey = options.connectorKey || "slack-sample";
    this.stopAfter = options.stopAfter || 0;
  }

  getConnectorKey() {
    return this.connectorKey;
  }

  getObjects() {
    return [...OBJECTS];
  }

  async testConnection() {
    return {
      ok: true,
      mode: "sample",
      users: this.userCount,
      channels: this.channelCount,
      messages: this.messageCount,
      shard: `${this.shardIndex + 1}/${this.shardCount}`,
    };
  }

  getSourceId(record) {
    return record.sourceId;
  }

  async *extract(object, options = {}) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown sample Slack object: ${object}`);
    }
    if (object === "users") yield* this.extractUsers();
    else if (object === "channels") yield* this.extractChannels();
    else yield* this.extractMessages(options);
  }

  async *extractUsers() {
    if (this.shardIndex !== 0) return;
    for (let i = 0; i < this.userCount; i += 1) {
      const id = `U${String(i).padStart(6, "0")}`;
      yield this.record("users", id, {
        userId: id,
        name: `user-${i}`,
        realName: `Sample User ${i}`,
        isBot: false,
        deleted: false,
      });
    }
  }

  async *extractChannels() {
    if (this.shardIndex !== 0) return;
    for (let i = 0; i < this.channelCount; i += 1) {
      const id = `C${String(i).padStart(6, "0")}`;
      yield this.record("channels", id, {
        channelId: id,
        name: `channel-${i}`,
        isPrivate: i % 5 === 0,
        memberCount: 12 + (i % 40),
      });
    }
  }

  async *extractMessages(options = {}) {
    const savedChannels = options.checkpoint?.channels || {};
    let yieldedInPage = 0;
    let produced = 0;
    let lastPage = 1;
    for (let i = 0; i < this.messageCount; i += 1) {
      if (i % this.shardCount !== this.shardIndex) continue;
      const channelId = `C${String(i % this.channelCount).padStart(6, "0")}`;
      const ts = (1_700_000_000 + i).toFixed(6);
      const savedTs = savedChannels[channelId]?.latest_ts;
      if (savedTs && ts <= String(savedTs)) continue;
      if (this.stopAfter && produced >= this.stopAfter) {
        throw new Error(`Stopped after ${this.stopAfter} records so the next run can resume`);
      }
      if (this.delayMs > 0 && yieldedInPage === 0) {
        await sleep(this.delayMs);
      }
      const page = Math.floor(i / this.pageSize) + 1;
      lastPage = page;
      const userId = `U${String(i % this.userCount).padStart(6, "0")}`;
      yield this.record("messages", `${channelId}:${ts}`, {
        channelId,
        messageId: ts,
        userId,
        text: `Sample message ${i} for channel ${channelId}. Benchmark payload for connector throughput.`,
        timestamp: ts,
        threadTs: null,
        replyCount: 0,
        subtype: null,
        editedTs: null,
        fileIds: [],
        sample: true,
        page,
        pageSize: this.pageSize,
      });
      produced += 1;
      yieldedInPage += 1;
      if (yieldedInPage >= this.pageSize) {
        if (this.logPages) {
          console.log(`[slack-sample] page ${page}: ${yieldedInPage} records (limit ${this.pageSize})`);
        }
        yieldedInPage = 0;
      }
    }
    if (this.logPages && yieldedInPage > 0) {
      console.log(`[slack-sample] page ${lastPage}: ${yieldedInPage} records (limit ${this.pageSize})`);
    }
  }

  record(object, sourceId, data) {
    const payload = {
      connectorKey: "slack",
      object,
      sourceId: String(sourceId),
      data,
      rawData: data,
      isDeleted: false,
      extractedAt: new Date().toISOString(),
    };
    payload.hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    return payload;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
