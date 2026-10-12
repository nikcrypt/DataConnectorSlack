import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DataConnector } from "../base/DataConnector.js";
import { parseFolderUrl } from "./parseFolderUrl.js";
import { WindowsFolderClient } from "./WindowsFolderClient.js";
import { incrementalWindow, inWindow } from "../base/incrementalWindow.js";

const OBJECTS = ["folders", "files"];
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const INCREMENTAL_OVERLAP_MS = 2000;
const MIME_TYPES = {
  ".txt": "text/plain", ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "application/javascript", ".json": "application/json", ".xml": "application/xml",
  ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip", ".rar": "application/x-rar-compressed", ".7z": "application/x-7z-compressed",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
  ".exe": "application/x-msdownload", ".dll": "application/x-msdownload",
  ".bat": "text/plain", ".cmd": "text/plain", ".ps1": "text/plain",
  ".py": "text/plain", ".c": "text/plain", ".cpp": "text/plain", ".h": "text/plain",
  ".cs": "text/plain", ".go": "text/plain", ".rs": "text/plain", ".php": "text/plain",
  ".sql": "text/plain", ".csv": "text/csv", ".log": "text/plain", ".md": "text/markdown",
};
const FILE_TYPE_EXTENSIONS = {
  Image: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".ico", ".webp"],
  Video: [".mp4", ".avi", ".mkv", ".mov"],
  Audio: [".mp3", ".wav", ".ogg"],
  Document: [".pdf", ".doc", ".docx", ".txt", ".rtf", ".xls", ".xlsx", ".csv"],
  Code: [".js", ".json", ".html", ".css", ".py", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".php", ".sql", ".sh", ".bat", ".cmd", ".ps1"],
  Archive: [".zip", ".rar", ".7z"],
};

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
   *   maxTotalDownloadBytes?: number,
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
    this.maxTotalDownloadBytes = config.maxTotalDownloadBytes ?? DEFAULT_MAX_TOTAL_DOWNLOAD_BYTES;
    this.download = config.download !== false;
    this.downloadDir = config.downloadDir || path.resolve("data/output/windows/downloads");
    this.seen = 0;
    this.downloadedBytes = 0;
  }

  static fromEnv() {
    const target = parseFolderUrl(process.env.WINDOWS_FOLDER_PATH || process.env.WINDOWS_FOLDER_URL);
    const client = new WindowsFolderClient(target, {
      username: process.env.WINDOWS_USERNAME,
      password: process.env.WINDOWS_PASSWORD,
      domain: process.env.WINDOWS_DOMAIN,
      concurrency: scanConcurrency(target.protocol),
      batchSize: numberEnv("WINDOWS_METADATA_BATCH_SIZE", 256),
    });
    return new WindowsConnector({
      client,
      maxDepth: numberEnv("WINDOWS_MAX_DEPTH", DEFAULT_MAX_DEPTH),
      maxFiles: numberEnv("WINDOWS_MAX_FILES", DEFAULT_MAX_FILES),
      maxDownloadBytes: numberEnv("WINDOWS_MAX_DOWNLOAD_BYTES", DEFAULT_MAX_DOWNLOAD_BYTES),
      maxTotalDownloadBytes: numberEnv(
        "WINDOWS_MAX_TOTAL_DOWNLOAD_BYTES",
        DEFAULT_MAX_TOTAL_DOWNLOAD_BYTES
      ),
      download: process.env.WINDOWS_DOWNLOAD === "true",
    });
  }

  getConnectorKey() {
    return "windows";
  }

  getObjects() {
    return [...OBJECTS];
  }

  getCheckpoint(object) {
    if (object === "files" || object === "folders") return { type: "timestamp" };
    return null;
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

  async *extract(object, options = {}) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Windows object: ${object}. Valid objects: ${OBJECTS.join(", ")}`);
    }
    this.seen = 0;
    this.downloadedBytes = 0;
    const checkpointTime = options.mode === "incremental"
      ? parseCheckpointTime(options.checkpoint)
      : null;
    this.resumeAfter = typeof options.resumeAfter === "string" ? options.resumeAfter : null;
    this.resumeFound = !this.resumeAfter;
    try {
      if (object === "folders") {
        yield* this.walkFolders("", 0, checkpointTime);
      } else {
        const window = incrementalWindow(options);
        if (window) {
          console.log(`[windows] incremental files modified from ${window.since.toISOString()} until ${window.until.toISOString()}`);
        }
        yield* this.walkFiles("", 0, window, checkpointTime);
      }
    } finally {
      await this.client.close();
    }
  }

  async *walkFolders(relative, depth, checkpointTime = null) {
    if (this.reachedLimit()) return;
    try {
      for await (const entry of this.client.iterate(relative)) {
        if (entry.kind !== "directory") continue;
        if (this.reachedLimit()) return;
        const child = joinRelative(relative, entry.name);
        this.seen += 1;
        if (isChangedSince(entry.modifiedAt, checkpointTime)) {
          const record = this.record("folders", child, {
            name: entry.name,
            path: child,
            ...folderMetadata(entry, child, this.client.target),
            modifiedAt: entry.modifiedAt,
          });
          if (this.shouldYieldRecord(record)) yield record;
        }
        if (this.canDescend(depth)) {
          yield* this.walkFolders(child, depth + 1, checkpointTime);
        }
      }
    } catch (err) {
      if (!isRecoverableFilesystemError(err)) throw err;
    }
  }

  async *walkFiles(relative, depth, window = null, checkpointTime = null) {
    if (this.reachedLimit()) return;
    try {
      for await (const entry of this.client.iterate(relative)) {
        if (this.reachedLimit()) return;
        const child = joinRelative(relative, entry.name);
        if (entry.kind === "directory") {
          if (this.canDescend(depth)) {
            yield* this.walkFiles(child, depth + 1, window, checkpointTime);
          }
          continue;
        }

        this.seen += 1;
        if (window && entry.modifiedAt && !inWindow(entry.modifiedAt, window)) continue;
        if (!isChangedSince(entry.modifiedAt, checkpointTime)) continue;

        const record = entry.kind === "file"
          ? this.record("files", child, {
            kind: "file",
            name: entry.name,
            path: child,
            ...fileMetadata(entry, child, this.client.target),
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            downloaded: false,
            downloadPath: null,
            skipReason: "metadata only",
          })
          : this.record("files", child, {
            kind: entry.kind,
            name: entry.name,
            path: child,
            ...fileMetadata(entry, child, this.client.target),
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            downloaded: false,
            downloadPath: null,
            skipReason: entry.kind === "symlink" ? "symlink" : entry.error || "unreadable",
          });
        if (this.shouldYieldRecord(record)) yield record;
      }
    } catch (err) {
      if (!isRecoverableFilesystemError(err)) throw err;
    }
  }

  reachedLimit() {
    return this.maxFiles > 0 && this.seen >= this.maxFiles;
  }

  canDescend(depth) {
    return this.maxDepth === 0 || depth + 1 < this.maxDepth;
  }

  shouldYieldRecord(record) {
    if (this.resumeFound) return true;
    if (record.sourceId === this.resumeAfter) this.resumeFound = true;
    return false;
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
    if (size > this.maxTotalDownloadBytes - this.downloadedBytes) {
      return {
        downloaded: false,
        downloadPath: null,
        skipReason: `run download limit of ${this.maxTotalDownloadBytes} bytes reached`,
      };
    }
    try {
      const bytes = await this.client.readFile(relative);
      if (bytes.length > this.maxDownloadBytes) {
        return { downloaded: false, downloadPath: null, skipReason: "file grew beyond per-file download limit" };
      }
      if (bytes.length > this.maxTotalDownloadBytes - this.downloadedBytes) {
        return { downloaded: false, downloadPath: null, skipReason: "file grew beyond remaining run download limit" };
      }
      const dest = safeDownloadPath(this.downloadDir, relative);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      this.downloadedBytes += bytes.length;
      return {
        downloaded: true,
        downloadPath: path.relative(path.resolve("data/output/windows"), dest),
        skipReason: null,
      };
    } catch (err) {
      return { downloaded: false, downloadPath: null, skipReason: err.message };
    }
  }

  async downloadByName(name, { page = 1, pageSize = 20 } = {}) {
    const requestedName = String(name || "").trim();
    if (!requestedName) throw new Error("Filename is required.");
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error("Page must be a positive integer.");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new Error("Page size must be an integer from 1 to 1000.");
    }

    const metadataPath = path.resolve("data/output/windows/files.jsonl");
    const start = (page - 1) * pageSize;
    const matches = [];
    let totalMatches = 0;
    try {
      const lines = readline.createInterface({
        input: createReadStream(metadataPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          throw new Error(`Invalid JSONL in files.jsonl at line ${lineNumber}. Run extraction again.`);
        }
        if (
          record.object === "files" &&
          typeof record.data?.name === "string" &&
          record.data.kind !== "symlink" &&
          record.data.name.toLowerCase() === requestedName.toLowerCase()
        ) {
          if (totalMatches >= start && totalMatches < start + pageSize) matches.push(record);
          totalMatches += 1;
        }
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error("Windows file metadata was not found. Run the Windows extraction first.");
      }
      throw err;
    }

    const totalPages = Math.ceil(totalMatches / pageSize);
    const selected = matches;
    const results = [];
    this.downloadedBytes = 0;

    try {
      for (const record of selected) {
        const relative = record.data.path;
        if (typeof relative !== "string" || !relative) {
          results.push({ name: record.data.name, downloaded: false, reason: "source path missing" });
          continue;
        }
        if (record.data.size == null) {
          results.push({ name: record.data.name, downloaded: false, reason: "size unknown" });
          continue;
        }
        if (record.data.size > this.maxDownloadBytes) {
          results.push({ name: record.data.name, downloaded: false, reason: "file exceeds per-file limit" });
          continue;
        }
        if (record.data.size > this.maxTotalDownloadBytes - this.downloadedBytes) {
          results.push({ name: record.data.name, downloaded: false, reason: "run download limit reached" });
          continue;
        }

        try {
          const bytes = await this.client.readFile(relative);
          if (bytes.length > this.maxDownloadBytes) {
            results.push({ name: record.data.name, downloaded: false, reason: "file grew beyond per-file limit" });
            continue;
          }
          if (bytes.length > this.maxTotalDownloadBytes - this.downloadedBytes) {
            results.push({ name: record.data.name, downloaded: false, reason: "file grew beyond remaining run limit" });
            continue;
          }
          const dest = await uniqueDownloadPath(this.downloadDir, record.data.name);
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, bytes, { flag: "wx" });
          this.downloadedBytes += bytes.length;
          results.push({
            name: record.data.name,
            downloaded: true,
            downloadPath: path.relative(path.resolve("data/output/windows"), dest),
          });
        } catch (err) {
          results.push({ name: record.data.name, downloaded: false, reason: err.message });
        }
      }
    } finally {
      await this.client.close();
    }

    return {
      query: requestedName,
      page,
      pageSize,
      totalMatches,
      totalPages,
      selected: selected.length,
      downloaded: results.filter((result) => result.downloaded).length,
      failed: results.filter((result) => !result.downloaded).length,
      results,
      downloadDir: this.downloadDir,
    };
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

function fileMetadata(entry, relative, target) {
  const extension = path.extname(entry.name).toLowerCase();
  const modified = validDate(entry.modifiedAt);
  const created = validDate(entry.createdAt);
  const accessed = validDate(entry.accessedAt);
  const fullPath = sourcePath(target, relative);
  const match = Object.entries(FILE_TYPE_EXTENSIONS).find(([, extensions]) => extensions.includes(extension));
  const age = modified ? Date.now() - modified.getTime() : Infinity;

  return {
    fullPath,
    relativePath: relative,
    extension,
    fileType: match ? match[0] : "File",
    mimeType: MIME_TYPES[extension] || "application/octet-stream",
    sizeFormatted: formatBytes(entry.size),
    createdDate: created?.toISOString() || null,
    modifiedDate: modified?.toISOString() || null,
    lastAccessedDate: accessed?.toISOString() || null,
    parentFolder: target.protocol === "smb" ? path.win32.dirname(fullPath) : path.dirname(fullPath),
    recent: age <= 24 * 60 * 60 * 1000,
    attributes: entry.attributes || null,
  };
}

function folderMetadata(entry, relative, target) {
  const fullPath = sourcePath(target, relative);
  const modified = validDate(entry.modifiedAt);
  const created = validDate(entry.createdAt);
  const age = modified ? Date.now() - modified.getTime() : Infinity;
  return {
    fullPath,
    relativePath: relative,
    parentFolder: target.protocol === "smb" ? path.win32.dirname(fullPath) : path.dirname(fullPath),
    createdDate: created?.toISOString() || null,
    modifiedDate: modified?.toISOString() || null,
    fileCount: 0,
    subfolderCount: 0,
    recent: age <= 24 * 60 * 60 * 1000,
    attributes: entry.attributes || null,
  };
}

function sourcePath(target, relative) {
  if (target.protocol === "file") {
    return path.join(target.localPath, ...relative.split("/").filter(Boolean));
  }
  const root = `\\\\${target.host}\\${target.share}${target.folder ? `\\${target.folder.replace(/\//g, "\\")}` : ""}`;
  return path.win32.join(root, ...relative.split("/").filter(Boolean));
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function joinRelative(parent, name) {
  if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
    throw new Error("Invalid folder entry name");
  }
  return parent ? `${parent}/${name}` : name;
}

async function uniqueDownloadPath(root, fileName) {
  const safeName = path.basename(String(fileName));
  const extension = path.extname(safeName);
  const baseName = path.basename(safeName, extension);
  for (let index = 0; ; index += 1) {
    const candidateName = index === 0 ? safeName : `${baseName} (${index})${extension}`;
    const candidate = safeDownloadPath(root, candidateName);
    try {
      await access(candidate);
    } catch (err) {
      if (err.code === "ENOENT") return candidate;
      throw err;
    }
  }
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function parseCheckpointTime(checkpoint) {
  const time = Date.parse(checkpoint?.lastSuccessfulAt || "");
  return Number.isFinite(time) ? time : null;
}

function isChangedSince(modifiedAt, checkpointTime) {
  if (checkpointTime == null) return true;
  const modifiedTime = Date.parse(modifiedAt || "");
  // An overlap avoids missing updates on filesystems with coarse timestamp
  // resolution; a few recent records may be emitted again intentionally.
  return !Number.isFinite(modifiedTime) || modifiedTime >= checkpointTime - INCREMENTAL_OVERLAP_MS;
}

function isRecoverableFilesystemError(err) {
  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(err?.code);
}

function scanConcurrency(protocol) {
  const network = protocol === "smb";
  const configured = numberEnv(
    network ? "NETWORK_SCAN_CONCURRENCY" : "LOCAL_SCAN_CONCURRENCY",
    network ? 16 : 32
  );
  return Math.max(1, Math.min(configured, network ? 32 : 64));
}
