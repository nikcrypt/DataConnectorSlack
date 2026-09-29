import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { ConfluenceClient } from "./ConfluenceClient.js";

const OBJECTS = ["spaces", "pages", "blogposts", "attachments"];

/**
 * Confluence Cloud connector.
 * Auth: email + API token (same Atlassian token as Jira on the same site).
 * Extracts page/blog metadata and a plain-text body excerpt — not attachment bytes.
 */
export class ConfluenceConnector extends DataConnector {
  /**
   * @param {{
   *   client: ConfluenceClient,
   *   maxPages?: number,
   *   maxBlogposts?: number,
   *   attachmentPageLimit?: number,
   *   bodyExcerptChars?: number,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.maxPages = config.maxPages ?? 500;
    this.maxBlogposts = config.maxBlogposts ?? 200;
    this.attachmentPageLimit = config.attachmentPageLimit ?? 50;
    this.bodyExcerptChars = config.bodyExcerptChars ?? 2000;
  }

  static fromEnv() {
    return new ConfluenceConnector({
      client: ConfluenceClient.fromEnv(),
      maxPages: process.env.CONFLUENCE_MAX_PAGES
        ? Number(process.env.CONFLUENCE_MAX_PAGES)
        : 500,
      maxBlogposts: process.env.CONFLUENCE_MAX_BLOGPOSTS
        ? Number(process.env.CONFLUENCE_MAX_BLOGPOSTS)
        : 200,
      attachmentPageLimit: process.env.CONFLUENCE_ATTACHMENT_PAGE_LIMIT
        ? Number(process.env.CONFLUENCE_ATTACHMENT_PAGE_LIMIT)
        : 50,
      bodyExcerptChars: process.env.CONFLUENCE_BODY_EXCERPT_CHARS
        ? Number(process.env.CONFLUENCE_BODY_EXCERPT_CHARS)
        : 2000,
    });
  }

  getConnectorKey() {
    return "confluence";
  }

  getObjects() {
    return [...OBJECTS];
  }

  async testConnection() {
    return this.client.testConnection();
  }

  getSourceId(record) {
    return record.sourceId;
  }

  async *extract(object) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Confluence object: ${object}`);
    }

    switch (object) {
      case "spaces":
        yield* this.extractSpaces();
        break;
      case "pages":
        yield* this.extractPages();
        break;
      case "blogposts":
        yield* this.extractBlogposts();
        break;
      case "attachments":
        yield* this.extractAttachments();
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
  }

  async *extractSpaces() {
    for await (const space of this.client.paginate("/wiki/api/v2/spaces", {
      descriptionFormat: "plain",
    })) {
      yield this.record(
        "spaces",
        space.id,
        {
          id: space.id,
          key: space.key || null,
          name: space.name || null,
          type: space.type || null,
          status: space.status || null,
          homepageId: space.homepageId || null,
          description: space.description?.plain?.value || space.description || null,
        },
        space
      );
    }
  }

  async *extractPages() {
    for await (const page of this.client.paginate(
      "/wiki/api/v2/pages",
      { "body-format": "storage" },
      25,
      this.maxPages
    )) {
      yield this.mapContent("pages", page);
    }
  }

  async *extractBlogposts() {
    for await (const post of this.client.paginate(
      "/wiki/api/v2/blogposts",
      { "body-format": "storage" },
      25,
      this.maxBlogposts
    )) {
      yield this.mapContent("blogposts", post);
    }
  }

  async *extractAttachments() {
    const pageIds = [];
    for await (const page of this.client.paginate(
      "/wiki/api/v2/pages",
      {},
      50,
      this.attachmentPageLimit
    )) {
      pageIds.push({ id: page.id, title: page.title || null });
    }

    for (const page of pageIds) {
      try {
        for await (const attachment of this.client.paginate(
          `/wiki/api/v2/pages/${encodeURIComponent(page.id)}/attachments`
        )) {
          yield this.record(
            "attachments",
            attachment.id,
            {
              id: attachment.id,
              title: attachment.title || attachment.fileName || null,
              mediaType: attachment.mediaType || null,
              fileSize: attachment.fileSize ?? null,
              status: attachment.status || null,
              pageId: page.id,
              pageTitle: page.title,
              downloadLink: attachment.downloadLink || attachment._links?.download || null,
              createdAt: attachment.createdAt || null,
              versionNumber: attachment.version?.number ?? null,
            },
            attachment
          );
        }
      } catch (err) {
        console.warn(
          `[confluence] attachments for page ${page.id} skipped:`,
          err.message
        );
      }
    }
  }

  mapContent(object, item) {
    const storage = item.body?.storage?.value || null;
    return this.record(
      object,
      item.id,
      {
        id: item.id,
        title: item.title || null,
        status: item.status || null,
        spaceId: item.spaceId || null,
        parentId: item.parentId || null,
        parentType: item.parentType || null,
        authorId: item.authorId || null,
        createdAt: item.createdAt || null,
        versionNumber: item.version?.number ?? null,
        versionCreatedAt: item.version?.createdAt || null,
        bodyExcerpt: excerptFromStorage(storage, this.bodyExcerptChars),
      },
      item
    );
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "confluence",
      object,
      sourceId: String(sourceId),
      data,
      rawData: raw,
      isDeleted: false,
      extractedAt: new Date().toISOString(),
    };
    payload.hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    return payload;
  }
}

function excerptFromStorage(html, maxChars) {
  if (!html || typeof html !== "string") return null;
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
