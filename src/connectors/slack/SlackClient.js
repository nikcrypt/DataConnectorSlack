const SLACK_API = "https://slack.com/api";

/** Hint which bot scopes are typically required per method. */
const METHOD_SCOPES = {
  "conversations.list": "channels:read, groups:read",
  "conversations.history": "channels:history, groups:history",
  "conversations.replies": "channels:history, groups:history",
  "users.list": "users:read",
  "usergroups.list": "usergroups:read",
  "files.list": "files:read",
  "team.info": "team:read",
};

/**
 * Thin Slack Web API client with cursor pagination and 429 backoff.
 * Never logs the token.
 */
export class SlackClient {
  /**
   * @param {string} token xoxb-... or xoxp-...
   * @param {{ maxRetries?: number, label?: string }} [options]
   */
  constructor(token, options = {}) {
    if (!token || !(token.startsWith("xoxb-") || token.startsWith("xoxp-"))) {
      throw new Error(
        "Slack token is missing or invalid. Expected xoxb- (bot) or xoxp- (user)."
      );
    }
    this.token = token;
    this.label = options.label || (token.startsWith("xoxb-") ? "bot" : "user");
    this.maxRetries = options.maxRetries ?? 5;
  }

  /**
   * Call one Slack Web API method.
   * @param {string} method e.g. "users.list"
   * @param {Record<string, string|number|boolean|undefined>} [params]
   */
  async call(method, params = {}) {
    let attempt = 0;

    while (true) {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        body.set(key, String(value));
      }

      const response = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") || 1);
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new Error(`Slack rate limited on ${method} after ${this.maxRetries} retries`);
        }
        await sleep(retryAfter * 1000);
        continue;
      }

      const data = await response.json();

      if (!data.ok) {
        if (data.error === "ratelimited") {
          const retryAfter = Number(response.headers.get("Retry-After") || 1);
          attempt += 1;
          if (attempt > this.maxRetries) {
            throw new Error(`Slack rate limited on ${method} after ${this.maxRetries} retries`);
          }
          await sleep(retryAfter * 1000);
          continue;
        }

        if (data.error === "missing_scope") {
          const needed = METHOD_SCOPES[method] || "see Slack OAuth & Permissions";
          const neededFromSlack = data.needed || null;
          const err = new Error(
            `Slack API ${method} failed: missing_scope` +
              (neededFromSlack ? ` (needed: ${neededFromSlack})` : ` (add scopes: ${needed})`) +
              ` using ${this.label} token`
          );
          err.code = "missing_scope";
          err.method = method;
          err.needed = neededFromSlack;
          throw err;
        }

        if (data.error === "not_in_channel") {
          const err = new Error(
            `Slack API ${method} failed: not_in_channel using ${this.label} token`
          );
          err.code = "not_in_channel";
          err.method = method;
          throw err;
        }

        throw new Error(`Slack API ${method} failed: ${data.error}`);
      }

      return data;
    }
  }

  /**
   * Yield every item across cursor pages.
   * @param {string} method
   * @param {string} listKey response field that holds the array (members, channels, messages, files)
   * @param {Record<string, string|number|boolean|undefined>} [params]
   */
  async *paginate(method, listKey, params = {}) {
    let cursor;

    do {
      const page = await this.call(method, {
        ...params,
        limit: params.limit ?? 200,
        cursor,
      });

      const items = page[listKey] || [];
      for (const item of items) {
        yield item;
      }

      cursor = page.response_metadata?.next_cursor || "";
    } while (cursor);
  }
}

/**
 * Prefer bot token; on missing_scope or not_in_channel, retry with user token when available.
 */
export class SlackDualClient {
  /**
   * @param {SlackClient} botClient
   * @param {SlackClient|null} userClient
   */
  constructor(botClient, userClient = null) {
    this.bot = botClient;
    this.user = userClient;
  }

  shouldFallback(err) {
    return (
      this.user &&
      (err.code === "missing_scope" || err.code === "not_in_channel")
    );
  }

  async call(method, params = {}) {
    try {
      return await this.bot.call(method, params);
    } catch (err) {
      if (this.shouldFallback(err)) {
        console.warn(
          `[slack] ${method}: bot ${err.code}; retrying with user token`
        );
        return this.user.call(method, params);
      }
      if (err.code === "missing_scope") {
        throw new Error(
          `${err.message}. Fix: add Bot Token Scopes → Reinstall to Workspace → update SLACK_BOT_TOKEN. ` +
            `Or set SLACK_USER_TOKEN with the matching User Token Scopes.`
        );
      }
      if (err.code === "not_in_channel") {
        throw new Error(
          `${err.message}. Fix: in Slack, /invite @YourBot into the channel (or use a user token that is a channel member).`
        );
      }
      throw err;
    }
  }

  async *paginate(method, listKey, params = {}) {
    let client = this.bot;
    let cursor;
    let switched = false;

    do {
      let page;
      try {
        page = await client.call(method, {
          ...params,
          limit: params.limit ?? 200,
          cursor,
        });
      } catch (err) {
        if (this.shouldFallback(err) && !switched) {
          console.warn(
            `[slack] ${method}: bot ${err.code}; continuing with user token`
          );
          client = this.user;
          switched = true;
          page = await client.call(method, {
            ...params,
            limit: params.limit ?? 200,
            cursor,
          });
        } else if (err.code === "missing_scope") {
          throw new Error(
            `${err.message}. Fix: add Bot Token Scopes → Reinstall → update SLACK_BOT_TOKEN, or set SLACK_USER_TOKEN.`
          );
        } else if (err.code === "not_in_channel") {
          throw new Error(
            `${err.message}. Fix: /invite @YourBot into the channel.`
          );
        } else {
          throw err;
        }
      }

      const items = page[listKey] || [];
      for (const item of items) {
        yield item;
      }

      cursor = page.response_metadata?.next_cursor || "";
    } while (cursor);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
