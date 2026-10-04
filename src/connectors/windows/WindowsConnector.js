import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DataConnector } from "../base/DataConnector.js";
import { parseFolderUrl } from "./parseFolderUrl.js";
import { WindowsFolderClient } from "./WindowsFolderClient.js";

const OBJECTS = ["folders", "files"];
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Reads one Windows or SMB folder URL.
 * Lists folders and files under that URL only.
 * Downloads a file when it is at or under WINDOWS_MAX_DOWNLOAD_BYTES.
 */
export class WindowsConnector extends DataConnector {
  /**
   * @param {{
   *   client: WindowsFolderClient,
   *   maxDepth?: number,
   *   maxFiles?: number,
   *   maxDownloadBytes?: number,
   *   download?: boolean,
   *   downloadDir?: string,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDownloadBytes = config.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.download = config.download !== false;
    this.downloadDir = config.downloadDir || path.resolve("data/output/windows/downloads");
    this.seen = 0;
  }

  static fromEnv() {
    const target = parseFolderUrl(process.env.WINDOWS_FOLDER_URL);
    const client = new WindowsFolderClient(target, {
      username: process.env.WINDOWS_USERNAME,
      password: process.env.WINDOWS_PASSWORD,
      domain: process.env.WINDOWS_DOMAIN,
    });
    return new WindowsConnector({
      client,
      maxDepth: numberEnv("WINDOWS_MAX_DEPTH", DEFAULT_MAX_DEPTH),
      maxFiles: numberEnv("WINDOWS_MAX_FILES", DEFAULT_MAX_FILES),
      maxDownloadBytes: numberEnv("WINDOWS_MAX_DOWNLOAD_BYTES", DEFAULT_MAX_DOWNLOAD_BYTES),
      download: process.env.WINDOWS_DOWNLOAD !== "false",
    });
  }

  getConnectorKey() {
    return "windows";
  }

  getObjects() {
    return [...OBJECTS];
  }

  async testConnection() {
    try {
      return await this.client.testConnection();
    } finally {
      await this.client.close();
    }
  }

  getSourceId(record) {
    return record.sourceId;
  }

  async *extract(object) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Windows object: ${object}. Valid objects: ${OBJECTS.join(", ")}`);
    }
    this.seen = 0;
    try {
      if (object === "folders") {
        yield* this.walkFolders("", 0);
      } else {
        yield* this.walkFiles("", 0);
      }
    } finally {
      await this.client.close();
    }
  }

  async *walkFolders(relative, depth) {
    if (this.seen >= this.maxFiles) return;
    const entries = await this.client.list(relative);
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      if (this.seen >= this.maxFiles) return;
      const child = joinRelative(relative, entry.name);
      this.seen += 1;
      yield this.record("folders", child, {
        name: entry.name,
        path: child,
        modifiedAt: entry.modifiedAt,
      });
      if (depth + 1 < this.maxDepth) {
        yield* this.walkFolders(child, depth + 1);
      }
    }
  }

  async *walkFiles(relative, depth) {
    if (this.seen >= this.maxFiles) return;
    const entries = await this.client.list(relative);
    for (const entry of entries) {
      if (this.seen >= this.maxFiles) return;
      const child = joinRelative(relative, entry.name);
      if (entry.kind === "directory") {
        if (depth + 1 < this.maxDepth) {
          yield* this.walkFiles(child, depth + 1);
        }
        continue;
      }
      if (entry.kind !== "file") {
        this.seen += 1;
        yield this.record("files", child, {
          name: entry.name,
          path: child,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          downloaded: false,
          downloadPath: null,
          skipReason: entry.kind === "symlink" ? "symlink" : entry.error || "unreadable",
        });
        continue;
      }

      this.seen += 1;
      const saved = await this.saveFile(child, entry.size);
      yield this.record("files", child, {
        name: entry.name,
        path: child,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        downloaded: saved.downloaded,
        downloadPath: saved.downloadPath,
        skipReason: saved.skipReason,
      });
    }
  }

  async saveFile(relative, size) {
    if (!this.download) {
      return { downloaded: false, downloadPath: null, skipReason: "download disabled" };
    }
    if (size == null) {
      return { downloaded: false, downloadPath: null, skipReason: "size unknown" };
    }
    if (size > this.maxDownloadBytes) {
      return {
        downloaded: false,
        downloadPath: null,
        skipReason: `larger than ${this.maxDownloadBytes} bytes`,
      };
    }
    try {
      const bytes = await this.client.readFile(relative);
      const dest = safeDownloadPath(this.downloadDir, relative);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      return {
        downloaded: true,
        downloadPath: path.relative(path.resolve("data/output/windows"), dest),
        skipReason: null,
      };
    } catch (err) {
      return { downloaded: false, downloadPath: null, skipReason: err.message };
    }
  }

  record(object, sourceId, data) {
    const payload = {
      connectorKey: "windows",
      object,
      sourceId: String(sourceId),
      data,
      rawData: null,
      isDeleted: false,
      extractedAt: new Date().toISOString(),
    };
    payload.hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    return payload;
  }
}

function joinRelative(parent, name) {
  if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
    throw new Error("Invalid folder entry name");
  }
  return parent ? `${parent}/${name}` : name;
}

function safeDownloadPath(root, relative) {
  const parts = String(relative).split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error("Path escapes the folder URL");
  }
  const destRoot = path.resolve(root);
  const dest = path.resolve(destRoot, ...parts);
  const prefix = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  if (dest !== destRoot && !dest.startsWith(prefix)) {
    throw new Error("Path escapes the download folder");
  }
  return dest;
}

function numberEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
