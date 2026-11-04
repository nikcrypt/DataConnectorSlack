import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { OracleClient } from "./OracleClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns", "table_data"];
const CHECKPOINT_OBJECTS = new Set(["tables", "views", "columns", "table_data"]);
const DATE_TYPE_PREFIXES = ["DATE", "TIMESTAMP"];
const MODIFIED_COLUMN_NAMES = [
  "MODIFIEDDATE",
  "LASTMODIFIEDDATE",
  "LASTMODIFIED",
  "UPDATEDAT",
  "UPDATEDDATE",
  "MODIFIEDAT",
  "UPDATEDATE",
  "MODIFIED_AT",
  "UPDATED_AT",
  "LAST_MODIFIED",
];

/**
 * Oracle connector.
 * Default objects are catalog metadata (ALL_* views).
 * Optional object `table_data` reads actual table rows (paginated).
 */
export class OracleConnector extends DataConnector {
  /**
   * @param {{
   *   client: OracleClient,
   *   allowedSchemas?: string[],
   *   pageSize?: number,
   *   schemaName?: string|null,
   *   tableName?: string|null,
   *   modifiedColumn?: string|null,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.allowedSchemas = config.allowedSchemas?.length ? config.allowedSchemas : null;
    this.pageSize = Number.isFinite(config.pageSize) && config.pageSize > 0
      ? config.pageSize
      : 1000;
    this.schemaName = config.schemaName || null;
    this.tableName = config.tableName || null;
    this.modifiedColumn = config.modifiedColumn || null;
  }

  static fromEnv() {
    const allowedSchemas = process.env.ORACLE_SCHEMAS
      ? process.env.ORACLE_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const pageSize = Number(process.env.EXPORT_PAGE_SIZE || process.env.ORACLE_PAGE_SIZE || 1000);

    return new OracleConnector({
      client: OracleClient.fromEnv(),
      allowedSchemas,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000,
      schemaName: process.env.ORACLE_SCHEMA?.trim() || null,
      tableName: process.env.ORACLE_TABLE?.trim() || null,
      modifiedColumn: process.env.ORACLE_MODIFIED_COLUMN?.trim() || null,
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
      const catalogWindow = object === "schemas" || object === "table_data"
        ? null
        : await this.catalogWindow(options);
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
        case "table_data":
          yield* this.extractTableData(options);
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

  /**
   * Read actual table rows (paginated). Limit with ORACLE_SCHEMA + ORACLE_TABLE.
   */
  async *extractTableData(options = {}) {
    const filter = this.client.ownerFilter(this.allowedSchemas, "t.owner");
    const binds = { ...filter.binds };
    let whereExtra = "";

    if (this.schemaName) {
      whereExtra += " AND t.owner = :schema_name";
      binds.schema_name = this.schemaName.toUpperCase();
    }
    if (this.tableName) {
      whereExtra += " AND t.table_name = :table_name";
      binds.table_name = this.tableName.toUpperCase();
    }

    const tables = await this.client.query(
      `
      SELECT t.owner AS schema_name, t.table_name
      FROM all_tables t
      WHERE 1 = 1
      ${filter.clause}${whereExtra}
      ORDER BY t.owner, t.table_name
      `,
      binds
    );

    const window = incrementalWindow(options);
    if (!window && !this.schemaName && !this.tableName) {
      console.log(
        "[oracle] table_data will read every visible user table. Set ORACLE_SCHEMA and ORACLE_TABLE to limit it."
      );
    }
    if (window) {
      console.log(
        `[oracle] incremental table rows modified from ${window.since.toISOString()} until ${window.until.toISOString()}`
      );
    }

    for (const table of tables) {
      const schemaName = table.SCHEMA_NAME;
      const tableName = table.TABLE_NAME;
      if (window) {
        yield* this.extractChangedRows(schemaName, tableName, window);
        continue;
      }

      const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
      const tableColumns = await this.client.getTableColumns(schemaName, tableName);
      const orderBy = tableColumns.length
        ? tableColumns.map((column) => quoteIdentifier(column)).join(", ")
        : "1";

      const totalRowsResult = await this.client.query(
        `SELECT COUNT(*) AS total_rows FROM ${fullTableName}`
      );
      const totalRows = Number(totalRowsResult[0]?.TOTAL_ROWS || 0);

      let offset = 0;
      let pageNumber = 0;

      while (offset < totalRows) {
        const pageRows = await this.client.query(
          `
          SELECT * FROM ${fullTableName}
          ORDER BY ${orderBy}
          OFFSET :offset_rows ROWS FETCH NEXT :limit_rows ROWS ONLY
          `,
          { offset_rows: offset, limit_rows: this.pageSize }
        );
        if (!pageRows.length) break;

        pageNumber += 1;
        const columns = tableColumns.length ? tableColumns : Object.keys(pageRows[0] || {});
        const dataRows = pageRows.map((row) => rowToObject(row, columns));

        const sourceId = `${schemaName}.${tableName}.page-${pageNumber}`;
        yield this.record("table_data", sourceId, {
          schemaName,
          tableName,
          pageNumber,
          pageSize: this.pageSize,
          offset,
          totalRows,
          rowCount: dataRows.length,
          columns,
          rows: dataRows,
          hasMore: offset + dataRows.length < totalRows,
        }, {
          schemaName,
          tableName,
          pageNumber,
          offset,
          totalRows,
          pageSize: this.pageSize,
          rowCount: dataRows.length,
          rows: dataRows,
        });

        offset += pageRows.length;
      }
    }
  }

  async *extractChangedRows(schemaName, tableName, window) {
    const column = await this.findModifiedColumn(schemaName, tableName);
    const qualified = `${schemaName}.${tableName}`;
    if (!column) {
      console.log(
        `[oracle] incremental table_data skipped ${qualified}: no date/timestamp modified column. Set ORACLE_MODIFIED_COLUMN.`
      );
      return;
    }

    const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
    const quotedColumn = quoteIdentifier(column);
    const rowFilter = `${quotedColumn} >= TO_TIMESTAMP(:since_ts, 'YYYY-MM-DD HH24:MI:SS') AND ${quotedColumn} < TO_TIMESTAMP(:until_ts, 'YYYY-MM-DD HH24:MI:SS')`;
    const filterBinds = {
      since_ts: sqlDateLiteral(window.since),
      until_ts: sqlDateLiteral(window.until),
    };
    console.log(`[oracle] incremental ${qualified} using ${column}`);

    const tableColumns = await this.client.getTableColumns(schemaName, tableName);
    const pkColumns = await this.primaryKeyColumns(schemaName, tableName);
    const orderColumns = pkColumns.length ? pkColumns : tableColumns;
    const orderBy = orderColumns.length
      ? orderColumns.map((name) => quoteIdentifier(name)).join(", ")
      : "1";

    const totalRowsResult = await this.client.query(
      `SELECT COUNT(*) AS total_rows FROM ${fullTableName} WHERE ${rowFilter}`,
      filterBinds
    );
    const totalRows = Number(totalRowsResult[0]?.TOTAL_ROWS || 0);
    let offset = 0;

    while (offset < totalRows) {
      const pageRows = await this.client.query(
        `
        SELECT * FROM ${fullTableName}
        WHERE ${rowFilter}
        ORDER BY ${orderBy}
        OFFSET :offset_rows ROWS FETCH NEXT :limit_rows ROWS ONLY
        `,
        { ...filterBinds, offset_rows: offset, limit_rows: this.pageSize }
      );
      if (!pageRows.length) break;

      const columns = tableColumns.length ? tableColumns : Object.keys(pageRows[0] || {});
      for (const row of pageRows) {
        const dataRow = rowToObject(row, columns);
        const primaryKey = {};
        for (const name of pkColumns) primaryKey[name] = dataRow[name];
        const identity = pkColumns.length ? pkColumns.map((name) => dataRow[name]) : [dataRow];
        const sourceId = `${qualified}.${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
        yield this.record("table_data", sourceId, {
          schemaName,
          tableName,
          pageNumber: null,
          pageSize: 1,
          offset: null,
          totalRows,
          rowCount: 1,
          columns,
          rows: [dataRow],
          hasMore: false,
          incremental: true,
          modifiedColumn: column,
          primaryKey: pkColumns.length ? primaryKey : null,
        }, {
          schemaName,
          tableName,
          modifiedColumn: column,
          row: dataRow,
        });
      }
      offset += pageRows.length;
    }
  }

  async findModifiedColumn(schemaName, tableName) {
    const rows = await this.client.query(
      `
      SELECT column_name, data_type
      FROM all_tab_columns
      WHERE owner = :owner AND table_name = :table_name
      `,
      {
        owner: String(schemaName).toUpperCase(),
        table_name: String(tableName).toUpperCase(),
      }
    );
    const wanted = this.modifiedColumn
      ? [this.modifiedColumn.toUpperCase()]
      : MODIFIED_COLUMN_NAMES;
    const byName = new Map(rows.map((row) => [String(row.COLUMN_NAME).toUpperCase(), row]));
    for (const name of wanted) {
      const row = byName.get(name.toUpperCase());
      if (!row) continue;
      const dataType = String(row.DATA_TYPE || "").toUpperCase();
      const isDate = DATE_TYPE_PREFIXES.some((prefix) => dataType.startsWith(prefix));
      if (!isDate) {
        if (this.modifiedColumn) {
          console.log(
            `[oracle] ${schemaName}.${tableName}.${row.COLUMN_NAME} is ${row.DATA_TYPE}, not a date/timestamp column`
          );
        }
        continue;
      }
      return row.COLUMN_NAME;
    }
    return null;
  }

  async primaryKeyColumns(schemaName, tableName) {
    const rows = await this.client.query(
      `
      SELECT cc.column_name
      FROM all_constraints c
      INNER JOIN all_cons_columns cc
        ON cc.owner = c.owner
       AND cc.constraint_name = c.constraint_name
      WHERE c.constraint_type = 'P'
        AND c.owner = :owner
        AND c.table_name = :table_name
      ORDER BY cc.position
      `,
      {
        owner: String(schemaName).toUpperCase(),
        table_name: String(tableName).toUpperCase(),
      }
    );
    return rows.map((row) => row.COLUMN_NAME);
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

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function rowToObject(row, columns) {
  const out = {};
  for (const column of columns) {
    const value = row[column] ?? row[String(column).toUpperCase()] ?? row[String(column).toLowerCase()];
    out[column] = serializeValue(value);
  }
  return out;
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

function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      encoding: "base64",
      data: value.toString("base64"),
    };
  }
  // node-oracledb Lob / ResultSet-like objects
  if (typeof value === "object" && typeof value.getData === "function") {
    return { type: "Lob", note: "LOB content not inlined in POC extract" };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = serializeValue(value[key]);
    }
    return out;
  }
  return value;
}
