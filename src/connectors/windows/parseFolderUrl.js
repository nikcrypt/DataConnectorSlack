const ADMIN_SHARE = /^(?:[a-z]\$|admin\$|ipc\$|print\$)$/i;

/**
 * @param {string} raw
 * @returns {{
 *   protocol: "file" | "smb",
 *   localPath?: string,
 *   host?: string,
 *   share?: string,
 *   folder?: string,
 *   port?: number,
 *   username?: string,
 *   password?: string,
 *   label: string,
 * }}
 */
export function parseFolderUrl(raw) {
  const input = String(raw || "").trim();
  if (!input) {
    throw new Error("Missing WINDOWS_FOLDER_URL");
  }

  if (input.startsWith("\\\\") || input.startsWith("//")) {
    return parseUnc(input);
  }
  if (/^[a-zA-Z]:([\\/]|$)/.test(input)) {
    return parseDrivePath(input);
  }
  if (input.toLowerCase().startsWith("smb://")) {
    return parseSmbUrl(input);
  }
  if (input.toLowerCase().startsWith("file://")) {
    return parseFileUrl(input);
  }
  if (input.startsWith("/")) {
    if (input === "/") {
      throw new Error("Folder URL must be a specific folder, not the filesystem root");
    }
    return { protocol: "file", localPath: input, label: input };
  }

  throw new Error(
    "WINDOWS_FOLDER_URL must be smb://host/share/folder, \\\\host\\share\\folder, or file:///path/to/folder"
  );
}

function parseUnc(input) {
  const parts = input.replace(/^[/\\]+/, "").split(/[/\\]/).filter(Boolean);
  const host = parts.shift();
  const share = parts.shift();
  const folder = parts.join("/");
  assertShare(host, share);
  assertFolder(folder);
  return {
    protocol: "smb",
    host,
    share,
    folder,
    port: 445,
    label: labelFor(host, share, folder),
  };
}

function parseDrivePath(input) {
  const normalized = input.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\/*$/.test(normalized)) {
    throw new Error("Folder URL must be a specific folder, not a drive root");
  }
  if (process.platform !== "win32") {
    throw new Error(
      "A drive-letter path only works when this connector runs on Windows. Use smb://host/share/folder, or file:///path when that folder is mounted"
    );
  }
  assertFolder(normalized.slice(2));
  return { protocol: "file", localPath: input, label: normalized };
}

function parseSmbUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid SMB folder URL");
  }
  const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  const share = parts.shift();
  const folder = parts.join("/");
  assertShare(url.hostname, share);
  assertFolder(folder);
  return {
    protocol: "smb",
    host: url.hostname,
    share,
    folder,
    port: url.port ? Number(url.port) : 445,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    label: labelFor(url.hostname, share, folder),
  };
}

function parseFileUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid file folder URL");
  }

  const host = url.hostname;
  if (host && host.toLowerCase() !== "localhost") {
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const share = parts.shift();
    const folder = parts.join("/");
    assertShare(host, share);
    assertFolder(folder);
    return {
      protocol: "smb",
      host,
      share,
      folder,
      port: 445,
      label: labelFor(host, share, folder),
    };
  }

  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:\//.test(pathname) || /^\/[a-zA-Z]:$/.test(pathname)) {
    return parseDrivePath(pathname.slice(1));
  }
  if (!pathname || pathname === "/") {
    throw new Error("Folder URL must be a specific folder, not the filesystem root");
  }
  return { protocol: "file", localPath: pathname, label: pathname };
}

function assertShare(host, share) {
  if (!host || !share) {
    throw new Error("SMB folder URL needs a host and a share name");
  }
  if (ADMIN_SHARE.test(share)) {
    throw new Error("Administrative shares are not supported. Use a specific shared folder");
  }
}

function assertFolder(folder) {
  if (!folder) return;
  const parts = folder.split(/[/\\]/).filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error("Folder URL cannot contain ..");
  }
}

function labelFor(host, share, folder) {
  return `smb://${host}/${share}${folder ? `/${folder}` : ""}`;
}
