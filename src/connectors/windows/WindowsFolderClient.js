import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { lstat, opendir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Local folders and Windows UNC shares use Node fs; Windows authenticates UNC
 * access through the active sign-in session. smb:// URLs on other platforms
 * use the SMB client on port 445.
 */
export class WindowsFolderClient {
  /**
   * @param {ReturnType<import('./parseFolderUrl.js').parseFolderUrl>} target
   * @param {{ username?: string, password?: string, domain?: string, concurrency?: number }} [auth]
   */
  constructor(target, auth = {}) {
    this.target = target;
    const credentials = normalizeSmbCredentials(
      auth.username || target.username || "",
      auth.domain || ""
    );
    this.username = credentials.username;
    this.password = auth.password || target.password || "";
    this.domain = credentials.domain;
    this.concurrency = Math.max(1, Math.min(Number(auth.concurrency) || 16, 64));
    this.batchSize = Math.max(16, Math.min(Number(auth.batchSize) || 256, 2048));
    this.smb = null;
    this.localRootPromise = null;
  }

  async testConnection() {
    try {
      const immediateEntries = this.target.protocol === "file" || this.usesNativeUnc()
        ? await this.countLocalEntries("")
        : (await this.list("")).length;
      return {
        ok: true,
        protocol: this.target.protocol,
        accessMethod: this.usesNativeUnc() ? "windows-native-filesystem" : this.target.protocol,
        folder: this.target.label,
        immediateEntries,
      };
    } catch (err) {
      throw addConnectionHint(this.target, err);
    }
  }

  async close() {
    if (this.smb) {
      this.smb.disconnect();
      this.smb = null;
    }
  }

  /**
   * @param {string} relative
   * @returns {Promise<Array<{ name: string, kind: "directory" | "file" | "symlink" | "unknown", size: number | null, modifiedAt: string | null, error?: string }>>}
   */
  async list(relative) {
    if (this.target.protocol === "file" || this.usesNativeUnc()) {
      const entries = [];
      for await (const entry of this.iterateLocal(relative)) entries.push(entry);
      return entries;
    }
    return this.listSmb(relative);
  }

  /**
   * Stream entries from a directory. Local and mounted paths use opendir so
   * directory contents are not materialized as a large array.
   */
  async *iterate(relative) {
    if (this.target.protocol === "file" || this.usesNativeUnc()) {
      yield* this.iterateLocal(relative);
      return;
    }
    for (const entry of await this.listSmb(relative)) yield entry;
  }

  /**
   * @param {string} relative
   * @returns {Promise<Buffer>}
   */
  async readFile(relative) {
    if (this.target.protocol === "file" || this.usesNativeUnc()) {
      const full = await this.localFullPath(relative);
      return readFile(full);
    }
    const client = this.getSmb();
    return client.readFile(smbJoin(this.target.folder, relative));
  }

  async listLocal(relative) {
    const dir = await this.localFullPath(relative);
    const stat = await lstat(dir);
    if (!stat.isDirectory()) {
      throw new Error("WINDOWS_FOLDER_URL is not a folder");
    }
    const dirents = await readdir(dir, { withFileTypes: true });
    return mapLimit(dirents, this.concurrency, async (dirent) => {
      if (dirent.name === "." || dirent.name === "..") return null;
      const full = path.join(dir, dirent.name);
      const child = await lstat(full);
      if (child.isSymbolicLink()) {
        return {
          name: dirent.name,
          kind: "symlink",
          size: child.size,
          modifiedAt: child.mtime.toISOString(),
          createdAt: child.birthtime.toISOString(),
          accessedAt: child.atime.toISOString(),
          attributes: localAttributes(dirent.name, child),
        };
      }
      if (!child.isDirectory() && !child.isFile()) {
        return {
          name: dirent.name,
          kind: "unknown",
          size: child.size,
          modifiedAt: child.mtime.toISOString(),
          createdAt: child.birthtime.toISOString(),
          accessedAt: child.atime.toISOString(),
          attributes: localAttributes(dirent.name, child),
          error: "unsupported filesystem entry type",
        };
      }
      return {
        name: dirent.name,
        kind: child.isDirectory() ? "directory" : "file",
        size: child.size,
        modifiedAt: child.mtime.toISOString(),
        createdAt: child.birthtime.toISOString(),
        accessedAt: child.atime.toISOString(),
        attributes: localAttributes(dirent.name, child),
      };
    }).then((entries) => entries.filter(Boolean));
  }

  async localFullPath(relative) {
    const root = await this.getLocalRoot();
    const full = this.pathUnderRoot(root, relative);
    // readFile is a public path operation, so resolve symlinks and enforce the
    // root boundary before opening a target. Traversal itself uses lstat and
    // does not follow symlinks.
    const resolved = await realpath(full);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(prefix)) {
      throw new Error("Path escapes the folder URL");
    }
    return resolved;
  }

  async getLocalRoot() {
    if (!this.localRootPromise) {
      const configuredRoot = this.target.protocol === "file"
        ? this.target.localPath
        : this.uncRootPath();
      this.localRootPromise = (async () => {
        try {
          const root = await realpath(configuredRoot);
          const rootStat = await lstat(root);
          if (!rootStat.isDirectory()) throw new Error("WINDOWS_FOLDER_URL is not a folder");
          return root;
        } catch (err) {
          if (err.code === "ENOENT") throw new Error(`Folder not found: ${this.target.label}`);
          throw err;
        }
      })();
    }
    return this.localRootPromise;
  }

  pathUnderRoot(root, relative) {
    const parts = String(relative || "").split(/[/\\]/).filter(Boolean);
    if (parts.some((part) => part === ".." || part === "." || part.includes(":"))) {
      throw new Error("Path escapes the folder URL");
    }
    const full = path.resolve(root, ...parts);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (full !== root && !full.startsWith(prefix)) throw new Error("Path escapes the folder URL");
    return full;
  }

  async *iterateLocal(relative) {
    const root = await this.getLocalRoot();
    const dir = this.pathUnderRoot(root, relative);
    let handle;
    try {
      handle = await opendir(dir);
      const batch = [];
      for await (const dirent of handle) {
        if (dirent.name === "." || dirent.name === "..") continue;
        batch.push(dirent);
        if (batch.length >= this.batchSize) {
          yield* this.describeLocalBatch(dir, batch.splice(0));
        }
      }
      if (batch.length) yield* this.describeLocalBatch(dir, batch);
    } catch (err) {
      // A vanished or unreadable directory should not abort its siblings.
      if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") {
        return;
      }
      throw err;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async countLocalEntries(relative) {
    const root = await this.getLocalRoot();
    const dir = this.pathUnderRoot(root, relative);
    let count = 0;
    let handle;
    try {
      handle = await opendir(dir);
      for await (const _entry of handle) count += 1;
      return count;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async *describeLocalBatch(dir, dirents) {
    const entries = await mapLimit(dirents, this.concurrency, async (dirent) => {
      const full = path.join(dir, dirent.name);
      try {
        const child = await lstat(full);
        const common = {
          name: dirent.name,
          size: child.size,
          modifiedAt: safeIso(child.mtime),
          createdAt: safeIso(child.birthtime),
          accessedAt: safeIso(child.atime),
          attributes: localAttributes(dirent.name, child),
        };
        if (child.isSymbolicLink()) return { ...common, kind: "symlink" };
        if (child.isDirectory()) return { ...common, kind: "directory" };
        if (child.isFile()) return { ...common, kind: "file" };
        return { ...common, kind: "unknown", error: "unsupported filesystem entry type" };
      } catch (err) {
        if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") {
          return {
            name: dirent.name,
            kind: "unknown",
            size: null,
            createdAt: null,
            modifiedAt: null,
            accessedAt: null,
            attributes: null,
            error: err.code === "ENOENT" ? "entry disappeared during scan" : "entry is inaccessible",
          };
        }
        throw err;
      }
    });
    for (const entry of entries) yield entry;
  }

  usesNativeUnc() {
    return this.target.protocol === "smb" && process.platform === "win32";
  }

  uncRootPath() {
    const folder = String(this.target.folder || "").replace(/[\\/]+/g, "\\");
    return `\\\\${this.target.host}\\${this.target.share}${folder ? `\\${folder}` : ""}`;
  }

  async listSmb(relative) {
    const client = this.getSmb();
    const dir = smbJoin(this.target.folder, relative);
    const names = await client.readdir(dir || ".");
    return mapLimit(names, this.concurrency, async (name) => {
      if (name === "." || name === "..") return null;
      const child = smbJoin(dir, name);
      return describeSmb(client, name, child);
    }).then((entries) => entries.filter(Boolean));
  }

  getSmb() {
    if (this.smb) return this.smb;
    ensureSmbCrypto();
    const SMB2 = require("@marsaud/smb2");
    this.smb = new SMB2({
      share: `\\\\${this.target.host}\\${this.target.share}`,
      domain: this.domain || "WORKGROUP",
      username: this.username,
      password: this.password,
      port: this.target.port || 445,
      autoCloseTimeout: 0,
    });
    return this.smb;
  }
}

async function describeSmb(client, name, fullPath) {
  try {
    await client.readdir(fullPath);
    return {
      name,
      kind: "directory",
      size: null,
      createdAt: null,
      modifiedAt: null,
      accessedAt: null,
      attributes: null,
    };
  } catch {
    let file;
    try {
      file = await client.open(fullPath, "r");
      const flags = Number(file.FileAttributes) >>> 0;
      const kind = flags & 0x400 ? "symlink" : "file";
      return {
        name,
        kind,
        size: bufferSize(file.EndofFile),
        createdAt: fileTimeToIso(file.CreationTime),
        modifiedAt: fileTimeToIso(file.LastWriteTime),
        accessedAt: fileTimeToIso(file.LastAccessTime),
        attributes: {
          hidden: Boolean(flags & 0x2),
          readOnly: Boolean(flags & 0x1),
          system: Boolean(flags & 0x4),
        },
      };
    } catch (err) {
      return {
        name,
        kind: "unknown",
        size: null,
        modifiedAt: null,
        error: err.message,
      };
    } finally {
      if (file) await client.close(file).catch(() => {});
    }
  }
}

function bufferSize(value) {
  if (!Buffer.isBuffer(value) || value.length < 8) return null;
  const size = value.readBigUInt64LE(0);
  return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : null;
}

function fileTimeToIso(value) {
  if (!Buffer.isBuffer(value) || value.length < 8) return null;
  const ticks = value.readBigUInt64LE(0);
  if (ticks === 0n || ticks === 0x7fffffffffffffffn) return null;
  const milliseconds = Number(ticks / 10000n - 11644473600000n);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function localAttributes(name, stat) {
  return {
    hidden: name.startsWith("."),
    readOnly: (stat.mode & 0o222) === 0,
    system: null,
  };
}

function safeIso(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(items.length, limit) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function ensureSmbCrypto() {
  if (process.execArgv.includes("--openssl-legacy-provider")) return;
  try {
    crypto.createCipheriv("des-ecb", Buffer.alloc(8), "");
    return;
  } catch (err) {
    if (err.code !== "ERR_OSSL_EVP_UNSUPPORTED") throw err;
  }
  const child = spawnSync(
    process.execPath,
    ["--openssl-legacy-provider", ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit" }
  );
  process.exit(child.status ?? 1);
}

function smbJoin(folder, relative) {
  const parts = `${folder || ""}/${relative || ""}`
    .split(/[/\\]/)
    .filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error("Path escapes the folder URL");
  }
  return parts.join("\\");
}

function normalizeSmbCredentials(username, domain) {
  const user = String(username || "").trim();
  const configuredDomain = String(domain || "").trim();
  const separator = user.indexOf("\\");
  if (separator > 0) {
    return {
      username: user.slice(separator + 1),
      domain: configuredDomain || user.slice(0, separator),
    };
  }
  return { username: user, domain: configuredDomain };
}

function addConnectionHint(target, err) {
  if (
    target.protocol === "smb" &&
    process.platform === "win32" &&
    (err.code === "EACCES" || err.code === "EPERM")
  ) {
    return new Error(
      `Windows denied filesystem access to ${target.label}. Confirm the share is connected in this Windows sign-in session and that the account has read access.`,
      { cause: err }
    );
  }
  if (
    target.protocol === "smb" &&
    (err.code === "STATUS_ACCESS_DENIED" || /STATUS_ACCESS_DENIED/i.test(err.message || ""))
  ) {
    return new Error(
      `SMB access was denied for ${target.label}. Check WINDOWS_USERNAME and WINDOWS_DOMAIN, the share name, and that the account has both share-level and folder-level read permissions. For a VM-local account, set WINDOWS_DOMAIN to the VM's computer name.`,
      { cause: err }
    );
  }
  return err;
}
