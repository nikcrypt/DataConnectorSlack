import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Lists and reads one folder. Local file URLs use Node fs.
 * smb:// and UNC paths use SMB on port 445.
 */
export class WindowsFolderClient {
  /**
   * @param {ReturnType<import('./parseFolderUrl.js').parseFolderUrl>} target
   * @param {{ username?: string, password?: string, domain?: string }} [auth]
   */
  constructor(target, auth = {}) {
    this.target = target;
    this.username = auth.username || target.username || "";
    this.password = auth.password || target.password || "";
    this.domain = auth.domain || "";
    this.smb = null;
  }

  async testConnection() {
    const entries = await this.list("");
    return {
      ok: true,
      protocol: this.target.protocol,
      folder: this.target.label,
      immediateEntries: entries.length,
    };
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
    if (this.target.protocol === "file") {
      return this.listLocal(relative);
    }
    return this.listSmb(relative);
  }

  /**
   * @param {string} relative
   * @returns {Promise<Buffer>}
   */
  async readFile(relative) {
    if (this.target.protocol === "file") {
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
    const entries = [];
    for (const dirent of dirents) {
      if (dirent.name === "." || dirent.name === "..") continue;
      const full = path.join(dir, dirent.name);
      const child = await lstat(full);
      if (child.isSymbolicLink()) {
        entries.push({
          name: dirent.name,
          kind: "symlink",
          size: child.size,
          modifiedAt: child.mtime.toISOString(),
        });
        continue;
      }
      entries.push({
        name: dirent.name,
        kind: child.isDirectory() ? "directory" : "file",
        size: child.size,
        modifiedAt: child.mtime.toISOString(),
      });
    }
    return entries;
  }

  async localFullPath(relative) {
    let root;
    try {
      root = await realpath(this.target.localPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`Folder not found: ${this.target.label}`);
      }
      throw err;
    }
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      throw new Error("WINDOWS_FOLDER_URL is not a folder");
    }
    const parts = String(relative || "").split(/[/\\]/).filter(Boolean);
    if (parts.some((part) => part === "..")) {
      throw new Error("Path escapes the folder URL");
    }
    const full = path.resolve(root, ...parts);
    const resolved = await realpath(full);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(prefix)) {
      throw new Error("Path escapes the folder URL");
    }
    return resolved;
  }

  async listSmb(relative) {
    const client = this.getSmb();
    const dir = smbJoin(this.target.folder, relative);
    const names = await client.readdir(dir || ".");
    const entries = [];
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const child = smbJoin(dir, name);
      entries.push(await describeSmb(client, name, child));
    }
    return entries;
  }

  getSmb() {
    if (this.smb) return this.smb;
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
    return { name, kind: "directory", size: null, modifiedAt: null };
  } catch {
    try {
      const size = await client.getSize(fullPath);
      return { name, kind: "file", size, modifiedAt: null };
    } catch (err) {
      return {
        name,
        kind: "unknown",
        size: null,
        modifiedAt: null,
        error: err.message,
      };
    }
  }
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
