import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { OracleClient } from "./OracleClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns"];
const CHECKPOINT_OBJECTS = new Set(["tables", "views", "columns"]);

/**
 * Oracle metadata connector.
 * Extracts schemas, tables, views, and columns from ALL_* catalog views.
 * Table row data is out of scope for this POC.
 */
export class OracleConnector extends DataConnector {
  /**
   * @param {{
   *   client: OracleClient,
   *   allowedSchemas?: string[],
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.allowedSchemas = config.allowedSchemas?.length ? config.allowedSchemas : null;
  }

  static fromEnv() {
    const allowedSchemas = process.env.ORACLE_SCHEMAS
      ? process.env.ORACLE_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    return new OracleConnector({
      client: OracleClient.fromEnv(),
      allowedSchemas,
    });
  }

  getConnectorKey() {
    return "oracle";
  }

  getObjects() {
    return [...OBJECTS];
  }

  async testConnection() {
    try {
      return await this.client.testConnection();
    } finally {
      await this.client.disconnect();
    }
  }

  getSourceId(record) {
    return record.sourceId;
  }

  getCheckpoint(object) {
    if (CHECKPOINT_OBJECTS.has(object)) return { type: "timestamp" };
    return null;
  }

  async *extract(object, options = {}) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Oracle object: ${object}`);
    }

    try {
      const catalogWindow = object === "schemas" ? null : await this.catalogWindow(options);
      switch (object) {
        case "schemas":
          yield* this.extractSchemas();
          break;
        case "tables":
          yield* this.extractTables(catalogWindow);
          break;
        case "views":
          yield* this.extractViews(catalogWindow);
          break;
        case "columns":
          yield* this.extractColumns(catalogWindow);
          break;
        default:
          throw new Error(`Extract not implemented for ${object}`);
      }
    } finally {
      await this.client.disconnect();
    }
  }

  async *extractSchemas() {
    const filter = this.client.ownerFilter(this.allowedSchemas, "owner");
    const sql = `
      SELECT DISTINCT owner AS schema_name
      FROM all_objects
      WHERE object_type IN ('TABLE', 'VIEW')
      ${filter.clause}
      ORDER BY owner
    `;
    const rows = await this.client.query(sql, filter.binds);

    for (const row of rows) {
      yield this.record("schemas", row.SCHEMA_NAME, {
        schemaName: row.SCHEMA_NAME,
      }, row);
    }
  }

  async catalogWindow(options) {
    const window = incrementalWindow(options);
    if (!window) return null;
    const rows = await this.client.query(`
      SELECT (SYSDATE - CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE)) * 1440 AS offset_minutes
      FROM dual
    `);
    const offsetMs = Math.round(Number(rows[0]?.OFFSET_MINUTES || 0)) * 60 * 1000;
    console.log(
      `[oracle] incremental catalog changes from ${window.since.toISOString()} until ${window.until.toISOString()}`
    );
    return {
      since: new Date(window.since.getTime() + offsetMs),
      until: new Date(window.until.getTime() + offsetMs),
    };
  }

  async *extractTables(window = null) {
    const filter = this.client.ownerFilter(this.allowedSchemas, "t.owner");
    const sql = `
      SELECT t.owner, t.table_name, t.tablespace_name, t.num_rows, o.created, o.last_ddl_time
      FROM all_tables t
      INNER JOIN all_objects o
        ON o.owner = t.owner
       AND o.object_name = t.table_name
       AND o.object_type = 'TABLE'
      WHERE 1 = 1
      ${filter.clause}
      ${ddlClause(window, "o")}
      ORDER BY t.owner, t.table_name
    `;
    const rows = await this.client.query(sql, filter.binds);

    for (const row of rows) {
      const sourceId = `${row.OWNER}.${row.TABLE_NAME}`;
      yield this.record("tables", sourceId, {
        schemaName: row.OWNER,
        tableName: row.TABLE_NAME,
        tablespaceName: row.TABLESPACE_NAME || null,
        numRows: row.NUM_ROWS ?? null,
        created: isoDate(row.CREATED),
        lastDdlTime: isoDate(row.LAST_DDL_TIME),
      }, row);
    }
  }

  async *extractViews(window = null) {
    const filter = this.client.ownerFilter(this.allowedSchemas, "v.owner");
    const sql = `
      SELECT v.owner, v.view_name, o.created, o.last_ddl_time
      FROM all_views v
      INNER JOIN all_objects o
        ON o.owner = v.owner
       AND o.object_name = v.view_name
       AND o.object_type = 'VIEW'
      WHERE 1 = 1
      ${filter.clause}
      ${ddlClause(window, "o")}
      ORDER BY v.owner, v.view_name
    `;
    const rows = await this.client.query(sql, filter.binds);

    for (const row of rows) {
      const sourceId = `${row.OWNER}.${row.VIEW_NAME}`;
      yield this.record("views", sourceId, {
        schemaName: row.OWNER,
        viewName: row.VIEW_NAME,
        created: isoDate(row.CREATED),
        lastDdlTime: isoDate(row.LAST_DDL_TIME),
      }, row);
    }
  }

  async *extractColumns(window = null) {
    const filter = this.client.ownerFilter(this.allowedSchemas, "c.owner");
    // DATA_DEFAULT is a LONG and is omitted — thin-mode fetches of LONG are unreliable.
    const sql = `
      SELECT
        c.owner,
        c.table_name,
        c.column_name,
        c.column_id,
        c.data_type,
        c.data_length,
        c.data_precision,
        c.data_scale,
        c.nullable,
        c.char_length,
        o.created,
        o.last_ddl_time
      FROM all_tab_columns c
      INNER JOIN all_objects o
        ON o.owner = c.owner
       AND o.object_name = c.table_name
       AND o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
      WHERE 1 = 1
      ${filter.clause}
      ${ddlClause(window, "o")}
      ORDER BY c.owner, c.table_name, c.column_id
    `;
    const rows = await this.client.query(sql, filter.binds);

    for (const row of rows) {
      const sourceId = `${row.OWNER}.${row.TABLE_NAME}.${row.COLUMN_NAME}`;
      yield this.record("columns", sourceId, {
        schemaName: row.OWNER,
        tableName: row.TABLE_NAME,
        columnName: row.COLUMN_NAME,
        ordinalPosition: row.COLUMN_ID,
        dataType: row.DATA_TYPE,
        dataLength: row.DATA_LENGTH ?? null,
        dataPrecision: row.DATA_PRECISION ?? null,
        dataScale: row.DATA_SCALE ?? null,
        nullable: row.NULLABLE === "Y",
        characterMaxLength: row.CHAR_LENGTH ?? null,
        created: isoDate(row.CREATED),
        lastDdlTime: isoDate(row.LAST_DDL_TIME),
      }, row);
    }
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "oracle",
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

function ddlClause(window, alias) {
  if (!window) return "";
  const since = sqlDateLiteral(window.since);
  const until = sqlDateLiteral(window.until);
  return `AND (
    (${alias}.last_ddl_time >= TO_DATE('${since}', 'YYYY-MM-DD HH24:MI:SS') AND ${alias}.last_ddl_time < TO_DATE('${until}', 'YYYY-MM-DD HH24:MI:SS'))
    OR (${alias}.created >= TO_DATE('${since}', 'YYYY-MM-DD HH24:MI:SS') AND ${alias}.created < TO_DATE('${until}', 'YYYY-MM-DD HH24:MI:SS'))
  )`;
}

function sqlDateLiteral(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day} ${time}`;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
