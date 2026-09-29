import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { BoxClient } from "./BoxClient.js";

const OBJECTS = ["users", "folders", "files", "collaborations"];

/**
 * Box connector.
 * Auth: developer token, CCG (client credentials), or OAuth refresh token.
 * Extracts metadata only (no file bytes).
 */
export class BoxConnector extends DataConnector {
  /**
   * @param {{
   *   client: BoxClient,
   *   rootFolderId?: string,
   *   maxDepth?: number,
   *   maxItems?: number,
   *   collaborationFolderLimit?: number,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.rootFolderId = config.rootFolderId || "0";
    this.maxDepth = config.maxDepth ?? 5;
    this.maxItems = config.maxItems ?? 2000;
    this.collaborationFolderLimit = config.collaborationFolderLimit ?? 50;
  }

  static fromEnv() {
    return new BoxConnector({
      client: BoxClient.fromEnv(),
      rootFolderId: process.env.BOX_ROOT_FOLDER_ID || "0",
      maxDepth: process.env.BOX_MAX_DEPTH
        ? Number(process.env.BOX_MAX_DEPTH)
        : 5,
      maxItems: process.env.BOX_MAX_ITEMS
        ? Number(process.env.BOX_MAX_ITEMS)
        : 2000,
      collaborationFolderLimit: process.env.BOX_COLLAB_FOLDER_LIMIT
        ? Number(process.env.BOX_COLLAB_FOLDER_LIMIT)
        : 50,
    });
  }

  getConnectorKey() {
    return "box";
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
      throw new Error(`Unknown Box object: ${object}`);
    }

    switch (object) {
      case "users":
        yield* this.extractUsers();
        break;
      case "folders":
        yield* this.extractFolders();
        break;
      case "files":
        yield* this.extractFiles();
        break;
      case "collaborations":
        yield* this.extractCollaborations();
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
  }

  async *extractUsers() {
    try {
      for await (const user of this.client.listUsers()) {
        yield this.record("users", user.id, {
          id: user.id,
          name: user.name || null,
          login: user.login || null,
          status: user.status || null,
          type: user.type || null,
          role: user.role || null,
          createdAt: user.created_at || null,
          modifiedAt: user.modified_at || null,
          spaceAmount: user.space_amount ?? null,
          spaceUsed: user.space_used ?? null,
          enterpriseId: user.enterprise?.id || null,
          enterpriseName: user.enterprise?.name || null,
        }, user);
      }
    } catch (err) {
      // Non-admin tokens cannot list enterprise users — fall back to /users/me
      console.warn("[box] users list skipped, falling back to /users/me:", err.message);
      const me = await this.client.request("/users/me");
      yield this.record("users", me.id, {
        id: me.id,
        name: me.name || null,
        login: me.login || null,
        status: me.status || null,
        type: me.type || null,
        role: me.role || null,
        createdAt: me.created_at || null,
        modifiedAt: me.modified_at || null,
        spaceAmount: me.space_amount ?? null,
        spaceUsed: me.space_used ?? null,
        enterpriseId: me.enterprise?.id || null,
        enterpriseName: me.enterprise?.name || null,
      }, me);
    }
  }

  async *extractFolders() {
    for await (const item of this.walkItems()) {
      if (item.type !== "folder") continue;
      yield this.mapItem("folders", item);
    }
  }

  async *extractFiles() {
    for await (const item of this.walkItems()) {
      if (item.type !== "file") continue;
      yield this.mapItem("files", item);
    }
  }

  async *extractCollaborations() {
    const folderIds = [];

    // Always include root
    folderIds.push(this.rootFolderId);

    for await (const item of this.walkItems()) {
      if (item.type !== "folder") continue;
      folderIds.push(item.id);
      if (folderIds.length >= this.collaborationFolderLimit) break;
    }

    const seen = new Set();
    for (const folderId of folderIds) {
      try {
        for await (const collab of this.client.listCollaborations(folderId)) {
          if (seen.has(collab.id)) continue;
          seen.add(collab.id);
          yield this.record(
            "collaborations",
            collab.id,
            {
              id: collab.id,
              folderId,
              role: collab.role || null,
              status: collab.status || null,
              createdAt: collab.created_at || null,
              modifiedAt: collab.modified_at || null,
              expiresAt: collab.expires_at || null,
              inviteEmail: collab.invite_email || null,
              accessibleByType: collab.accessible_by?.type || null,
              accessibleById: collab.accessible_by?.id || null,
              accessibleByName: collab.accessible_by?.name || null,
              accessibleByLogin: collab.accessible_by?.login || null,
              createdById: collab.created_by?.id || null,
              createdByName: collab.created_by?.name || null,
            },
            collab
          );
        }
      } catch (err) {
        console.warn(
          `[box] collaborations for folder ${folderId} skipped:`,
          err.message
        );
      }
    }
  }

  /**
   * BFS walk from root folder. Yields folder entries (including root) and file entries.
   * Shared by folders/files extracts — each extract filters by type.
   * Note: called separately per object, so tree is walked twice; acceptable for POC.
   */
  async *walkItems() {
    // Emit root folder metadata first
    try {
      const root = await this.client.getFolder(this.rootFolderId);
      yield root;
    } catch (err) {
      console.warn("[box] root folder fetch failed:", err.message);
    }

    const queue = [{ id: this.rootFolderId, depth: 0 }];
    let count = 1; // root counted

    while (queue.length > 0 && count < this.maxItems) {
      const { id, depth } = queue.shift();
      if (depth >= this.maxDepth) continue;

      try {
        for await (const item of this.client.listFolderItems(id)) {
          yield item;
          count += 1;
          if (count >= this.maxItems) return;

          if (item.type === "folder") {
            queue.push({ id: item.id, depth: depth + 1 });
          }
        }
      } catch (err) {
        console.warn(`[box] folder ${id} items skipped:`, err.message);
      }
    }
  }

  mapItem(object, item) {
    return this.record(
      object,
      item.id,
      {
        id: item.id,
        type: item.type || null,
        name: item.name || null,
        size: item.size ?? null,
        extension: item.extension || null,
        description: item.description || null,
        sha1: item.sha1 || null,
        createdAt: item.created_at || null,
        modifiedAt: item.modified_at || null,
        itemStatus: item.item_status || null,
        parentId: item.parent?.id || null,
        parentName: item.parent?.name || null,
        ownedById: item.owned_by?.id || null,
        ownedByLogin: item.owned_by?.login || null,
        ownedByName: item.owned_by?.name || null,
        createdById: item.created_by?.id || null,
        createdByName: item.created_by?.name || null,
        path: (item.path_collection?.entries || []).map((e) => e.name).join("/"),
        sharedLinkUrl: item.shared_link?.url || null,
      },
      item
    );
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "box",
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
