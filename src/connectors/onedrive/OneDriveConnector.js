import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DataConnector } from "../base/DataConnector.js";
import { MicrosoftGraphClient } from "../microsoft/MicrosoftGraphClient.js";

const CONFIG_PATH = new URL("../../config/connectors/onedrive.json", import.meta.url);

export class OneDriveConnector extends DataConnector {
  constructor({ client, userId, objects }) {
    super();

    if (!client) {
      throw new Error("OneDrive Microsoft Graph client is required");
    }
    if (!userId?.trim()) {
      throw new Error("OneDrive user ID is required");
    }
    if (!objects || typeof objects !== "object" || Array.isArray(objects)) {
      throw new Error("OneDrive object configuration is required");
    }

    this.client = client;
    this.userId = userId.trim();
    this.objects = objects;
    this.drive = null;
    this.nextCheckpoints = new Map();
  }

  static fromEnv() {
    const config = loadConfig();
    const oneDriveGraphClient = new MicrosoftGraphClient({
      tenantId: process.env.ONEDRIVE_TENANT_ID,
      clientId: process.env.ONEDRIVE_CLIENT_ID,
      clientSecret: process.env.ONEDRIVE_CLIENT_SECRET,
    });
    return new OneDriveConnector({
      client: oneDriveGraphClient,
      userId: process.env.ONEDRIVE_USER_ID,
      objects: config.objects,
    });
  }

  getConnectorKey() {
    return "onedrive";
  }

  getObjects() {
    return Object.entries(this.objects)
      .filter(([, definition]) => definition.enabled !== false)
      .map(([name]) => name);
  }

  getSourceId(record) {
    return record.sourceId;
  }

  getCheckpoint(object) {
    const definition = this.objects[object];
    if (object !== "driveItems" || !definition || definition.enabled === false) {
      return null;
    }
    return { type: "cursor" };
  }

  getNextCheckpoint(object) {
    return this.nextCheckpoints.get(object) || null;
  }

  async testConnection() {
    const drive = await this.ensureDrive();

    return {
      ok: true,
      userId: this.userId,
      driveId: drive.id,
      name: drive.name || null,
      driveType: drive.driveType || null,
      webUrl: drive.webUrl || null,
    };
  }

  async *extract(object, options = {}) {
    const definition = this.objects[object];
    if (!definition || definition.enabled === false) {
      throw new Error(`Unknown OneDrive object: ${object}`);
    }
    const drive = await this.ensureDrive();

    switch (object) {
      case "drives": {
        const data = mapFields(drive, definition.fields, object);
        data.userId = this.userId;
        yield this.createRecord(
          "drives",
          drive.id,
          data,
          drive,
        );
        break;
      }
      case "driveItems":
        yield* this.extractDriveItems(drive, definition, options);
        break;
      default:
        throw new Error(`OneDrive extraction is not implemented for ${object}`);
    }
  }

  async ensureDrive() {
    if (this.drive) return this.drive;

    const userId = encodeURIComponent(this.userId);
    let firstDrive = null;
    for await (const page of this.client.paginatePages(`/users/${userId}/drives`, {
      requestName: "OneDrive drives",
    })) {
      if (!Array.isArray(page.value)) {
        throw new Error("Microsoft Graph OneDrive drives response must contain a value array");
      }

      for (const drive of page.value) {
        if (!drive?.id) {
          throw new Error("Microsoft Graph returned OneDrive information without a drive ID");
        }
        firstDrive ||= drive;
        if (drive.driveType === "business") {
          this.drive = drive;
          return this.drive;
        }
      }
    }

    if (!firstDrive) {
      throw new Error(`No OneDrive was found for ${this.userId}`);
    }
    this.drive = firstDrive;
    return this.drive;
  }

  async *extractDriveItems(drive, definition, options) {
    const incremental = options.mode === "incremental";
    const savedCursor = options.checkpoint?.cursor;
    if (incremental && (typeof savedCursor !== "string" || !savedCursor.trim())) {
      throw new Error("Incremental OneDrive extraction requires a saved delta cursor");
    }

    const path = incremental
      ? savedCursor
      : `/drives/${encodeURIComponent(drive.id)}/root/delta`;
    this.nextCheckpoints.delete("driveItems");

    for await (const page of this.client.paginatePages(path, {
      requestName: "OneDrive items",
    })) {
      if (!Array.isArray(page.value)) {
        throw new Error(
          "Microsoft Graph OneDrive items response must contain a value array",
        );
      }

      for (const item of page.value) {
        if (!item?.id) {
          throw new Error(
            "Microsoft Graph returned a OneDrive item without an ID",
          );
        }

        const isFolder = Boolean(item.folder);
        const data = mapFields(item, definition.fields, "driveItems");
        data.driveId = drive.id;
        data.isFolder = isFolder;
        const isDeleted = Boolean(item.deleted);
        yield this.createRecord(
          "driveItems",
          `${drive.id}:${item.id}`,
          data,
          item,
          isDeleted,
        );
      }

      const deltaLink = page["@odata.deltaLink"];
      if (deltaLink !== undefined) {
        if (typeof deltaLink !== "string" || !deltaLink.trim()) {
          throw new Error("Microsoft Graph returned an invalid OneDrive delta link");
        }
        this.nextCheckpoints.set("driveItems", { cursor: deltaLink });
      }
    }

    if (!this.nextCheckpoints.has("driveItems")) {
      throw new Error("Microsoft Graph did not return a OneDrive delta link");
    }
  }

  createRecord(object, sourceId, data, rawData, isDeleted = false) {
    return {
      connectorKey: "onedrive",
      object,
      sourceId: String(sourceId),
      data,
      rawData,
      hash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      isDeleted,
      extractedAt: new Date().toISOString(),
    };
  }
}

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (
    config.connector !== "onedrive"
    || !config.objects
    || typeof config.objects !== "object"
    || Array.isArray(config.objects)
  ) {
    throw new Error("Invalid OneDrive connector config");
  }
  return config;
}

function mapFields(record, fields, objectName) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`OneDrive field mapping is required for ${objectName}`);
  }

  const data = {};
  const targetNames = new Set();
  for (const [sourcePath, targetName] of Object.entries(fields)) {
    const outputName = typeof targetName === "string" ? targetName.trim() : "";
    if (!sourcePath.trim() || !outputName) {
      throw new Error(`OneDrive field mapping for ${sourcePath} is invalid`);
    }
    if (targetNames.has(outputName)) {
      throw new Error(`OneDrive field mapping uses ${outputName} more than once`);
    }

    targetNames.add(outputName);
    const value = readPath(record, sourcePath);
    data[outputName] = value === undefined ? null : value;
  }
  return data;
}

function readPath(record, path) {
  return path.split(".").reduce(
    (value, key) => value === undefined || value === null ? undefined : value[key],
    record,
  );
}
