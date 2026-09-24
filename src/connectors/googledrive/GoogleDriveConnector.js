import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { GoogleDriveClient } from "./GoogleDriveClient.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const OBJECTS = ["drives", "files", "folders", "permissions"];

/**
 * Google Drive connector.
 * Auth: service account JSON, OAuth refresh token, or bearer access token.
 * Extracts metadata only (no file bytes).
 */
export class GoogleDriveConnector extends DataConnector {
  /**
   * @param {{
   *   client: GoogleDriveClient,
   *   maxFiles?: number,
   *   includeSharedDrives?: boolean,
   *   permissionFileLimit?: number,
   *   query?: string,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.maxFiles = config.maxFiles ?? 2000;
    this.includeSharedDrives = config.includeSharedDrives !== false;
    this.permissionFileLimit = config.permissionFileLimit ?? 50;
    this.query = config.query || null;
  }

  static fromEnv() {
    return new GoogleDriveConnector({
      client: GoogleDriveClient.fromEnv(),
      maxFiles: process.env.GOOGLE_DRIVE_MAX_FILES
        ? Number(process.env.GOOGLE_DRIVE_MAX_FILES)
        : 2000,
      includeSharedDrives:
        process.env.GOOGLE_DRIVE_INCLUDE_SHARED !== "false",
      permissionFileLimit: process.env.GOOGLE_DRIVE_PERMISSION_FILE_LIMIT
        ? Number(process.env.GOOGLE_DRIVE_PERMISSION_FILE_LIMIT)
        : 50,
      query: process.env.GOOGLE_DRIVE_QUERY || null,
    });
  }

  getConnectorKey() {
    return "googledrive";
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
      throw new Error(`Unknown Google Drive object: ${object}`);
    }

    switch (object) {
      case "drives":
        yield* this.extractDrives();
        break;
      case "files":
        yield* this.extractFiles();
        break;
      case "folders":
        yield* this.extractFolders();
        break;
      case "permissions":
        yield* this.extractPermissions();
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
  }

  async *extractDrives() {
    // Synthetic My Drive entry (user root is not returned by drives.list)
    yield this.record(
      "drives",
      "my-drive",
      {
        id: "my-drive",
        name: "My Drive",
        kind: "drive#user",
        createdTime: null,
        isSharedDrive: false,
      },
      { id: "my-drive", name: "My Drive" }
    );

    if (!this.includeSharedDrives) return;

    try {
      for await (const drive of this.client.listDrives()) {
        yield this.record(
          "drives",
          drive.id,
          {
            id: drive.id,
            name: drive.name || null,
            kind: drive.kind || null,
            createdTime: drive.createdTime || null,
            isSharedDrive: true,
            restrictions: drive.restrictions || null,
          },
          drive
        );
      }
    } catch (err) {
      console.warn("[googledrive] shared drives skipped:", err.message);
    }
  }

  async *extractFiles() {
    const baseQ = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    const q = this.query ? `(${baseQ}) and (${this.query})` : baseQ;

    for await (const file of this.client.listFiles({
      q,
      maxItems: this.maxFiles,
    })) {
      yield this.mapFile("files", file);
    }

    if (this.includeSharedDrives) {
      yield* this.extractFromSharedDrives("files", baseQ);
    }
  }

  async *extractFolders() {
    const baseQ = `trashed = false and mimeType = '${FOLDER_MIME}'`;
    const q = this.query ? `(${baseQ}) and (${this.query})` : baseQ;

    for await (const file of this.client.listFiles({
      q,
      maxItems: this.maxFiles,
    })) {
      yield this.mapFile("folders", file);
    }

    if (this.includeSharedDrives) {
      yield* this.extractFromSharedDrives("folders", baseQ);
    }
  }

  async *extractFromSharedDrives(object, baseQ) {
    try {
      for await (const drive of this.client.listDrives()) {
        const q = this.query ? `(${baseQ}) and (${this.query})` : baseQ;
        for await (const file of this.client.listFiles({
          q,
          driveId: drive.id,
          maxItems: this.maxFiles,
        })) {
          yield this.mapFile(object, file);
        }
      }
    } catch (err) {
      console.warn(`[googledrive] shared-drive ${object} skipped:`, err.message);
    }
  }

  async *extractPermissions() {
    // Collect a limited set of file/folder ids from My Drive, then fetch permissions
    const ids = [];
    const q = "trashed = false";

    for await (const file of this.client.listFiles({
      q,
      maxItems: this.permissionFileLimit,
    })) {
      ids.push({ id: file.id, name: file.name, mimeType: file.mimeType });
      if (ids.length >= this.permissionFileLimit) break;
    }

    for (const item of ids) {
      try {
        for await (const perm of this.client.listPermissions(item.id)) {
          const sourceId = `${item.id}:${perm.id}`;
          yield this.record(
            "permissions",
            sourceId,
            {
              fileId: item.id,
              fileName: item.name || null,
              fileMimeType: item.mimeType || null,
              permissionId: perm.id,
              type: perm.type || null,
              role: perm.role || null,
              emailAddress: perm.emailAddress || null,
              domain: perm.domain || null,
              displayName: perm.displayName || null,
              deleted: Boolean(perm.deleted),
              allowFileDiscovery: perm.allowFileDiscovery ?? null,
            },
            perm
          );
        }
      } catch (err) {
        console.warn(
          `[googledrive] permissions for ${item.id} skipped:`,
          err.message
        );
      }
    }
  }

  mapFile(object, file) {
    const isFolder = file.mimeType === FOLDER_MIME;
    return this.record(
      object,
      file.id,
      {
        id: file.id,
        name: file.name || null,
        mimeType: file.mimeType || null,
        isFolder,
        parents: file.parents || [],
        ownerEmails: (file.owners || [])
          .map((o) => o.emailAddress)
          .filter(Boolean),
        ownerNames: (file.owners || [])
          .map((o) => o.displayName)
          .filter(Boolean),
        createdTime: file.createdTime || null,
        modifiedTime: file.modifiedTime || null,
        size: file.size != null ? Number(file.size) : null,
        md5Checksum: file.md5Checksum || null,
        webViewLink: file.webViewLink || null,
        shared: Boolean(file.shared),
        starred: Boolean(file.starred),
        trashed: Boolean(file.trashed),
        driveId: file.driveId || null,
        spaces: file.spaces || [],
      },
      file
    );
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "googledrive",
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
