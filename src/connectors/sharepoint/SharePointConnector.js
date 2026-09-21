import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { SharePointClient } from "./SharePointClient.js";

const OBJECTS = ["sites", "lists", "columns", "listItems", "drives", "driveItems"];

/**
 * SharePoint Online connector via Microsoft Graph.
 * Extracts sites, lists, columns, list items, drives and drive item metadata.
 * File binary download is out of scope.
 */
export class SharePointConnector extends DataConnector {
  /**
   * @param {{
   *   client: SharePointClient,
   *   hostname: string,
   *   sitePath: string,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.hostname = config.hostname;
    this.sitePath = config.sitePath;
    this._site = null;
  }

  static fromEnv() {
    const hostname = process.env.SHAREPOINT_HOSTNAME;
    const sitePath = process.env.SHAREPOINT_SITE_PATH || "/";

    if (!hostname) {
      throw new Error(
        "Missing SHAREPOINT_HOSTNAME (e.g. contoso.sharepoint.com). Also set SHAREPOINT_SITE_PATH (e.g. /sites/engineering)."
      );
    }

    return new SharePointConnector({
      client: SharePointClient.fromEnv(),
      hostname,
      sitePath,
    });
  }

  getConnectorKey() {
    return "sharepoint";
  }

  getObjects() {
    return [...OBJECTS];
  }

  async ensureSite() {
    if (this._site) return this._site;
    this._site = await this.client.getSiteByPath(this.hostname, this.sitePath);
    return this._site;
  }

  async testConnection() {
    await this.client.getAccessToken();
    const site = await this.ensureSite();
    return {
      ok: true,
      siteId: site.id,
      displayName: site.displayName,
      name: site.name,
      webUrl: site.webUrl,
    };
  }

  getSourceId(record) {
    return record.sourceId;
  }

  async *extract(object) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown SharePoint object: ${object}`);
    }

    const site = await this.ensureSite();

    switch (object) {
      case "sites":
        yield* this.extractSites(site);
        break;
      case "lists":
        yield* this.extractLists(site);
        break;
      case "columns":
        yield* this.extractColumns(site);
        break;
      case "listItems":
        yield* this.extractListItems(site);
        break;
      case "drives":
        yield* this.extractDrives(site);
        break;
      case "driveItems":
        yield* this.extractDriveItems(site);
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
  }

  async *extractSites(site) {
    yield this.record("sites", site.id, {
      siteId: site.id,
      displayName: site.displayName || null,
      name: site.name || null,
      webUrl: site.webUrl || null,
      createdDateTime: site.createdDateTime || null,
      lastModifiedDateTime: site.lastModifiedDateTime || null,
    }, site);
  }

  async *extractLists(site) {
    for await (const list of this.client.paginate(`/sites/${site.id}/lists`)) {
      yield this.record("lists", `${site.id}:${list.id}`, {
        siteId: site.id,
        listId: list.id,
        name: list.name || null,
        displayName: list.displayName || null,
        description: list.description || null,
        template: list.list?.template || null,
        webUrl: list.webUrl || null,
        createdDateTime: list.createdDateTime || null,
        lastModifiedDateTime: list.lastModifiedDateTime || null,
      }, list);
    }
  }

  async *extractColumns(site) {
    for await (const list of this.client.paginate(`/sites/${site.id}/lists`)) {
      try {
        for await (const column of this.client.paginate(
          `/sites/${site.id}/lists/${list.id}/columns`
        )) {
          if (column.hidden) continue;
          yield this.record(
            "columns",
            `${site.id}:${list.id}:${column.id || column.name}`,
            {
              siteId: site.id,
              listId: list.id,
              listName: list.displayName || list.name || null,
              columnId: column.id || null,
              name: column.name || null,
              displayName: column.displayName || null,
              required: Boolean(column.required),
              readOnly: Boolean(column.readOnly),
              columnType: detectColumnType(column),
            },
            column
          );
        }
      } catch (err) {
        console.warn(`[sharepoint] columns skipped for list ${list.id}:`, err.message);
      }
    }
  }

  async *extractListItems(site) {
    for await (const list of this.client.paginate(`/sites/${site.id}/lists`)) {
      // Skip pure document libraries if desired? Keep all lists for POC.
      try {
        for await (const item of this.client.paginate(
          `/sites/${site.id}/lists/${list.id}/items`,
          "value",
          { $expand: "fields" }
        )) {
          yield this.record(
            "listItems",
            `${site.id}:${list.id}:${item.id}`,
            {
              siteId: site.id,
              listId: list.id,
              listName: list.displayName || list.name || null,
              itemId: item.id,
              webUrl: item.webUrl || null,
              createdDateTime: item.createdDateTime || null,
              lastModifiedDateTime: item.lastModifiedDateTime || null,
              contentType: item.contentType?.name || null,
              fields: item.fields || {},
            },
            item
          );
        }
      } catch (err) {
        console.warn(`[sharepoint] listItems skipped for list ${list.id}:`, err.message);
      }
    }
  }

  async *extractDrives(site) {
    for await (const drive of this.client.paginate(`/sites/${site.id}/drives`)) {
      yield this.record("drives", `${site.id}:${drive.id}`, {
        siteId: site.id,
        driveId: drive.id,
        name: drive.name || null,
        driveType: drive.driveType || null,
        webUrl: drive.webUrl || null,
      }, drive);
    }
  }

  async *extractDriveItems(site) {
    for await (const drive of this.client.paginate(`/sites/${site.id}/drives`)) {
      try {
        yield* this.walkDriveChildren(site.id, drive.id, `/drives/${drive.id}/root/children`);
      } catch (err) {
        console.warn(`[sharepoint] driveItems skipped for drive ${drive.id}:`, err.message);
      }
    }
  }

  async *walkDriveChildren(siteId, driveId, path, depth = 0) {
    // Bound depth for POC to avoid huge libraries
    if (depth > 5) return;

    for await (const item of this.client.paginate(path)) {
      const isFolder = Boolean(item.folder);
      yield this.record(
        "driveItems",
        `${driveId}:${item.id}`,
        {
          siteId,
          driveId,
          itemId: item.id,
          name: item.name || null,
          size: item.size ?? null,
          webUrl: item.webUrl || null,
          mimeType: item.file?.mimeType || null,
          isFolder,
          childCount: item.folder?.childCount ?? null,
          parentPath: item.parentReference?.path || null,
          createdDateTime: item.createdDateTime || null,
          lastModifiedDateTime: item.lastModifiedDateTime || null,
        },
        item
      );

      if (isFolder && item.id) {
        yield* this.walkDriveChildren(
          siteId,
          driveId,
          `/drives/${driveId}/items/${item.id}/children`,
          depth + 1
        );
      }
    }
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "sharepoint",
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

function detectColumnType(column) {
  if (column.text) return "text";
  if (column.choice) return "choice";
  if (column.number) return "number";
  if (column.boolean) return "boolean";
  if (column.dateTime) return "dateTime";
  if (column.currency) return "currency";
  if (column.lookup) return "lookup";
  if (column.personOrGroup) return "personOrGroup";
  if (column.hyperlinkOrPicture) return "hyperlinkOrPicture";
  if (column.calculated) return "calculated";
  return column["@odata.type"] || "unknown";
}
