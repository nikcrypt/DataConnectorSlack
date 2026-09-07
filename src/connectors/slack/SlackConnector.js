import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { SlackClient, SlackDualClient } from "./SlackClient.js";

const OBJECTS = [
  "workspaces",
  "users",
  "userGroups",
  "channels",
  "messages",
  "threads",
  "reactions",
  "files",
];

/**
 * Slack source connector.
 * Extracts workspace data via Web API and yields normalised connector records.
 * File binary download is out of scope — metadata only.
 */
export class SlackConnector extends DataConnector {
  /**
   * @param {{
   *   botToken: string,
   *   userToken?: string|null,
   *   historyDays?: number|null,
   *   channelIds?: string[],
   * }} config
   */
  constructor(config) {
    super();
    const bot = new SlackClient(config.botToken, { label: "bot" });
    const user =
      config.userToken && config.userToken.startsWith("xoxp-")
        ? new SlackClient(config.userToken, { label: "user" })
        : null;
    this.client = new SlackDualClient(bot, user);
    this.historyDays = config.historyDays ?? null;
    this.channelIds = config.channelIds?.length ? config.channelIds : null;
    this._auth = null;
  }

  getObjects() {
    return [...OBJECTS];
  }

  async testConnection() {
    const auth = await this.client.call("auth.test");
    this._auth = auth;
    return {
      ok: true,
      teamId: auth.team_id,
      team: auth.team,
      userId: auth.user_id,
      botId: auth.bot_id,
    };
  }

  async ensureAuth() {
    if (!this._auth) {
      await this.testConnection();
    }
    return this._auth;
  }

  getSourceId(record, object) {
    return record.sourceId;
  }

  getCheckpoint(object) {
    return null;
  }

  /**
   * @param {string} object
   * @param {{ checkpoint?: object, channelIds?: string[] }} [options]
   */
  async *extract(object, options = {}) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Slack object: ${object}`);
    }

    await this.ensureAuth();

    switch (object) {
      case "workspaces":
        yield* this.extractWorkspaces();
        break;
      case "users":
        yield* this.extractUsers();
        break;
      case "userGroups":
        yield* this.extractUserGroups();
        break;
      case "channels":
        yield* this.extractChannels();
        break;
      case "messages":
        yield* this.extractMessages(options);
        break;
      case "threads":
        yield* this.extractThreads(options);
        break;
      case "reactions":
        yield* this.extractReactions(options);
        break;
      case "files":
        yield* this.extractFiles();
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
  }

  async *extractWorkspaces() {
    const auth = await this.ensureAuth();
    let team = {
      id: auth.team_id,
      name: auth.team,
    };

    try {
      const info = await this.client.call("team.info");
      team = info.team || team;
    } catch {
      // team.info may need team:read; auth.test is enough for POC
    }

    yield this.record("workspaces", team.id, {
      workspaceId: team.id,
      name: team.name,
      domain: team.domain || null,
      enterpriseId: team.enterprise_id || null,
    }, team);
  }

  async *extractUsers() {
    for await (const user of this.client.paginate("users.list", "members")) {
      if (user.is_bot && user.id === "USLACKBOT") continue;

      yield this.record(
        "users",
        user.id,
        {
          userId: user.id,
          teamId: user.team_id,
          name: user.name,
          realName: user.real_name || null,
          displayName: user.profile?.display_name || null,
          email: user.profile?.email || null,
          isBot: Boolean(user.is_bot),
          isAdmin: Boolean(user.is_admin),
          deleted: Boolean(user.deleted),
          tz: user.tz || null,
          updated: user.updated ? String(user.updated) : null,
        },
        user
      );
    }
  }

  async *extractUserGroups() {
    try {
      const result = await this.client.call("usergroups.list", {
        include_users: true,
        include_disabled: false,
      });

      for (const group of result.usergroups || []) {
        yield this.record(
          "userGroups",
          group.id,
          {
            userGroupId: group.id,
            name: group.name,
            handle: group.handle,
            description: group.description || null,
            userIds: group.users || [],
            dateCreate: group.date_create || null,
            dateUpdate: group.date_update || null,
          },
          group
        );
      }
    } catch (err) {
      if (String(err.message).includes("missing_scope") || String(err.message).includes("not_allowed")) {
        console.warn("[slack] usergroups.list skipped:", err.message);
        return;
      }
      throw err;
    }
  }

  async *extractChannels() {
    const types = "public_channel,private_channel";

    for await (const channel of this.client.paginate("conversations.list", "channels", {
      types,
      exclude_archived: false,
    })) {
      if (this.channelIds && !this.channelIds.includes(channel.id)) continue;

      yield this.record(
        "channels",
        channel.id,
        {
          channelId: channel.id,
          name: channel.name || null,
          isChannel: Boolean(channel.is_channel),
          isPrivate: Boolean(channel.is_private),
          isIm: Boolean(channel.is_im),
          isMpim: Boolean(channel.is_mpim),
          isArchived: Boolean(channel.is_archived),
          created: channel.created || null,
          creator: channel.creator || null,
          topic: channel.topic?.value || null,
          purpose: channel.purpose?.value || null,
          numMembers: channel.num_members ?? null,
        },
        channel
      );
    }
  }

  async listChannelIds(options = {}) {
    if (options.channelIds?.length) return options.channelIds;
    if (this.channelIds?.length) return this.channelIds;

    const ids = [];
    for await (const channel of this.client.paginate("conversations.list", "channels", {
      types: "public_channel,private_channel",
      exclude_archived: true,
    })) {
      ids.push(channel.id);
    }
    return ids;
  }

  oldestTs() {
    if (!this.historyDays) return undefined;
    const seconds = Math.floor(Date.now() / 1000) - this.historyDays * 24 * 60 * 60;
    return String(seconds);
  }

  async *extractMessages(options = {}) {
    const channelIds = await this.listChannelIds(options);
    const oldest = this.oldestTs();
    const checkpoints = options.checkpoint?.channels || {};

    for (const channelId of channelIds) {
      const channelOldest = checkpoints[channelId]?.latest_ts
        ? String(checkpoints[channelId].latest_ts)
        : oldest;

      try {
        for await (const message of this.client.paginate("conversations.history", "messages", {
          channel: channelId,
          oldest: channelOldest,
          inclusive: false,
        })) {
          // Skip thread replies here — they come from conversations.replies
          if (message.thread_ts && message.thread_ts !== message.ts) continue;

          yield this.record(
            "messages",
            `${channelId}:${message.ts}`,
            {
              channelId,
              messageId: message.ts,
              userId: message.user || message.bot_id || null,
              text: message.text || "",
              timestamp: message.ts,
              threadTs: message.thread_ts || null,
              replyCount: message.reply_count || 0,
              subtype: message.subtype || null,
              editedTs: message.edited?.ts || null,
              fileIds: (message.files || []).map((f) => f.id),
            },
            message
          );
        }
      } catch (err) {
        // Bot not in channel, or missing scope — skip and continue
        console.warn(`[slack] history skipped for ${channelId}:`, err.message);
      }
    }
  }

  async *extractThreads(options = {}) {
    const channelIds = await this.listChannelIds(options);
    const oldest = this.oldestTs();

    for (const channelId of channelIds) {
      try {
        for await (const message of this.client.paginate("conversations.history", "messages", {
          channel: channelId,
          oldest,
        })) {
          if (!message.reply_count || message.reply_count < 1) continue;
          if (!message.ts) continue;

          for await (const reply of this.client.paginate("conversations.replies", "messages", {
            channel: channelId,
            ts: message.ts,
          })) {
            // First item is the parent — skip it
            if (reply.ts === message.ts) continue;

            yield this.record(
              "threads",
              `${channelId}:${reply.ts}`,
              {
                channelId,
                messageId: reply.ts,
                parentMessageId: message.ts,
                threadTs: reply.thread_ts || message.ts,
                userId: reply.user || reply.bot_id || null,
                text: reply.text || "",
                timestamp: reply.ts,
              },
              reply
            );
          }
        }
      } catch (err) {
        console.warn(`[slack] threads skipped for ${channelId}:`, err.message);
      }
    }
  }

  async *extractReactions(options = {}) {
    const channelIds = await this.listChannelIds(options);
    const oldest = this.oldestTs();

    for (const channelId of channelIds) {
      try {
        for await (const message of this.client.paginate("conversations.history", "messages", {
          channel: channelId,
          oldest,
        })) {
          for (const reaction of message.reactions || []) {
            const sourceId = `${channelId}:${message.ts}:${reaction.name}`;
            yield this.record(
              "reactions",
              sourceId,
              {
                reactionId: sourceId,
                messageId: message.ts,
                channelId,
                emoji: reaction.name,
                count: reaction.count,
                userIds: reaction.users || [],
              },
              reaction
            );
          }

          // Also scan thread replies for reactions
          if (message.reply_count > 0) {
            for await (const reply of this.client.paginate("conversations.replies", "messages", {
              channel: channelId,
              ts: message.ts,
            })) {
              for (const reaction of reply.reactions || []) {
                const sourceId = `${channelId}:${reply.ts}:${reaction.name}`;
                yield this.record(
                  "reactions",
                  sourceId,
                  {
                    reactionId: sourceId,
                    messageId: reply.ts,
                    channelId,
                    emoji: reaction.name,
                    count: reaction.count,
                    userIds: reaction.users || [],
                  },
                  reaction
                );
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[slack] reactions skipped for ${channelId}:`, err.message);
      }
    }
  }

  async *extractFiles() {
    try {
      for await (const file of this.client.paginate("files.list", "files")) {
        yield this.record(
          "files",
          file.id,
          {
            fileId: file.id,
            name: file.name || null,
            title: file.title || null,
            fileType: file.filetype || null,
            mimeType: file.mimetype || null,
            size: file.size ?? null,
            uploader: file.user || null,
            createdAt: file.created || file.timestamp || null,
            channels: file.channels || [],
            // Reference only — do not download binary content
            url: file.url_private || null,
          },
          file
        );
      }
    } catch (err) {
      console.warn("[slack] files.list skipped:", err.message);
    }
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "slack",
      object,
      sourceId: String(sourceId),
      data,
      rawData: raw,
      isDeleted: false,
      extractedAt: new Date().toISOString(),
    };
    payload.hash = hashRecord(payload.data);
    return payload;
  }
}

function hashRecord(data) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
