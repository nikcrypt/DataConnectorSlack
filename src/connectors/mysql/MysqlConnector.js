import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { resolveTableDataTargets } from "../base/resolveTableDataTargets.js";
import { MysqlClient } from "./MysqlClient.js";

const METADATA_OBJECTS = ["schemas", "tables", "views", "columns"];
const OBJECTS = [...METADATA_OBJECTS, "table_data"];
const CHECKPOINT_OBJECTS = new Set(["tables", "columns", "table_data"]);
const DATE_TYPES = new Set([
  "date",
  "datetime",
  "timestamp",
  "timestamp(0)",
  "timestamp(1)",
  "timestamp(2)",
  "timestamp(3)",
  "timestamp(4)",
  "timestamp(5)",
  "timestamp(6)",
]);
const MODIFIED_COLUMN_NAMES = [
  "ModifiedDate",
  "LastModifiedDate",
  "LastModified",
  "UpdatedAt",
  "UpdatedDate",
  "ModifiedAt",
  "UpdateDate",
  "modified_at",
  "updated_at",
  "last_modified",
];

/**
 * MySQL connector.
 * Default objects are catalog metadata (information_schema).
 * Optional object `table_data` reads actual table rows (paginated).
 */
export class MysqlConnector extends DataConnector {
  /**
   * @param {{
   *   client: MysqlClient,
   *   allowedSchemas?: string[],
   *   pageSize?: number,
   *   schemaName?: string|null,
   *   tableName?: string|null,
   *   tablesSpec?: string|null,
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
    this.tablesSpec = config.tablesSpec || null;
    this.modifiedColumn = config.modifiedColumn || null;
  }

  static fromEnv() {
    const allowedSchemas = process.env.MYSQL_SCHEMAS
      ? process.env.MYSQL_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const pageSize = Number(process.env.EXPORT_PAGE_SIZE || process.env.MYSQL_PAGE_SIZE || 1000);

    return new MysqlConnector({
      client: MysqlClient.fromEnv(),
      allowedSchemas,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000,
      schemaName: process.env.MYSQL_SCHEMA?.trim() || null,
      tableName: process.env.MYSQL_TABLE?.trim() || null,
      tablesSpec: process.env.MYSQL_TABLES?.trim() || null,
      modifiedColumn: process.env.MYSQL_MODIFIED_COLUMN?.trim() || null,
    });
  }

  getConnectorKey() {
    return "mysql";
  }

  getObjects() {
    return [...OBJECTS];
  }

  /** Metadata only — table_data is opt-in via --objects table_data */
  getDefaultObjects() {
    return [...METADATA_OBJECTS];
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
      throw new Error(`Unknown MySQL object: ${object}`);
    }

    try {
      const catalogWindow = object === "schemas" || object === "views" || object === "table_data"
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
          yield* this.extractViews();
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

  async catalogWindow(options) {
    const window = incrementalWindow(options);
    if (!window) return null;
    const rows = await this.client.query(
      "SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offset_minutes"
    );
    const offsetMs = Math.round(Number(rows[0]?.offset_minutes || 0)) * 60 * 1000;
    console.log(
      `[mysql] incremental catalog changes from ${window.since.toISOString()} until ${window.until.toISOString()}`
    );
    return {
      since: new Date(window.since.getTime() + offsetMs),
      until: new Date(window.until.getTime() + offsetMs),
    };
  }

  async *extractSchemas() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "SCHEMA_NAME");
    const rows = await this.client.query(
      `
      SELECT SCHEMA_NAME AS schema_name
      FROM information_schema.SCHEMATA
      WHERE 1 = 1 ${filter.clause}
      ORDER BY SCHEMA_NAME
      `,
      filter.params
    );

    for (const row of rows) {
      yield this.record("schemas", row.schema_name, {
        schemaName: row.schema_name,
      }, row);
    }
  }

  async *extractTables(window = null) {
    const filter = this.client.schemaFilter(this.allowedSchemas, "TABLE_SCHEMA");
    const rows = await this.client.query(
      `
      SELECT
        TABLE_SCHEMA AS table_schema,
        TABLE_NAME AS table_name,
        TABLE_TYPE AS table_type,
        CREATE_TIME AS create_time,
        UPDATE_TIME AS update_time
      FROM information_schema.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE' ${filter.clause} ${changeClause(window)}
      ORDER BY TABLE_SCHEMA, TABLE_NAME
      `,
      filter.params
    );

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}`;
      yield this.record("tables", sourceId, {
        schemaName: row.table_schema,
        tableName: row.table_name,
        tableType: row.table_type,
        createTime: isoDate(row.create_time),
        updateTime: isoDate(row.update_time),
      }, row);
    }
  }

  async *extractViews() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "TABLE_SCHEMA");
    const rows = await this.client.query(
      `
      SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
      FROM information_schema.VIEWS
      WHERE 1 = 1 ${filter.clause}
      ORDER BY TABLE_SCHEMA, TABLE_NAME
      `,
      filter.params
    );

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}`;
      yield this.record("views", sourceId, {
        schemaName: row.table_schema,
        viewName: row.table_name,
      }, row);
    }
  }

  async *extractColumns(window = null) {
    const filter = this.client.schemaFilter(this.allowedSchemas, "c.TABLE_SCHEMA");
    const rows = await this.client.query(
      `
      SELECT
        c.TABLE_SCHEMA AS table_schema,
        c.TABLE_NAME AS table_name,
        c.COLUMN_NAME AS column_name,
        c.ORDINAL_POSITION AS ordinal_position,
        c.DATA_TYPE AS data_type,
        c.COLUMN_TYPE AS column_type,
        c.IS_NULLABLE AS is_nullable,
        c.COLUMN_DEFAULT AS column_default,
        c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
        t.CREATE_TIME AS create_time,
        t.UPDATE_TIME AS update_time
      FROM information_schema.COLUMNS c
      INNER JOIN information_schema.TABLES t
        ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
       AND t.TABLE_NAME = c.TABLE_NAME
      WHERE 1 = 1 ${filter.clause} ${window ? "AND t.TABLE_TYPE = 'BASE TABLE'" : ""} ${changeClause(window, "t")}
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
      `,
      filter.params
    );

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}.${row.column_name}`;
      yield this.record("columns", sourceId, {
        schemaName: row.table_schema,
        tableName: row.table_name,
        columnName: row.column_name,
        ordinalPosition: row.ordinal_position,
        dataType: row.data_type,
        columnType: row.column_type,
        nullable: row.is_nullable === "YES",
        defaultValue: row.column_default,
        characterMaxLength: row.character_maximum_length,
        createTime: isoDate(row.create_time),
        updateTime: isoDate(row.update_time),
      }, row);
    }
  }

  /**
   * Read actual table rows (paginated).
   * Configure MYSQL_SCHEMA + MYSQL_TABLE, or MYSQL_TABLES (comma-separated).
   */
  async *extractTableData(options = {}) {
    const targets = resolveTableDataTargets({
      schema: this.schemaName,
      table: this.tableName,
      tables: this.tablesSpec,
      envPrefix: "MYSQL",
    });
    const tables = await this.resolveMysqlTables(targets);
    if (!tables.length) {
      throw new Error(
        `MySQL table_data: none of the configured tables were found or visible (${targets
          .map((t) => `${t.schemaName}.${t.tableName}`)
          .join(", ")})`
      );
    }

    const window = incrementalWindow(options);
    if (window) {
      console.log(
        `[mysql] incremental table rows modified from ${window.since.toISOString()} until ${window.until.toISOString()}`
      );
    }

    for (const table of tables) {
      const schemaName = table.table_schema;
      const tableName = table.table_name;
      if (window) {
        yield* this.extractChangedRows(schemaName, tableName, window);
        continue;
      }

      const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
      const tableColumns = await this.client.getTableColumns(schemaName, tableName);
      const pkColumns = await this.primaryKeyColumns(schemaName, tableName);
      const orderColumns = pkColumns.length ? pkColumns : tableColumns.slice(0, 1);
      const orderBy = orderColumns.length
        ? orderColumns.map((column) => quoteIdentifier(column)).join(", ")
        : "1";

      console.log(
        `[mysql] table_data ${schemaName}.${tableName} pageSize=${this.pageSize} orderBy=${orderColumns.join(",") || "1"}`
      );

      let offset = 0;
      let pageNumber = 0;
      let extractedRows = 0;

      while (true) {
        const pageRows = await this.client.query(
          `
          SELECT * FROM ${fullTableName}
          ORDER BY ${orderBy}
          LIMIT ${this.pageSize} OFFSET ${offset}
          `
        );
        if (!pageRows.length) break;

        pageNumber += 1;
        const columns = tableColumns.length ? tableColumns : Object.keys(pageRows[0] || {});
        const dataRows = pageRows.map((row) => {
          const out = {};
          for (const column of columns) {
            out[column] = serializeValue(row[column]);
          }
          return out;
        });
        extractedRows += dataRows.length;
        const hasMore = pageRows.length >= this.pageSize;

        const sourceId = `${schemaName}.${tableName}.page-${pageNumber}`;
        yield this.record("table_data", sourceId, {
          schemaName,
          tableName,
          pageNumber,
          pageSize: this.pageSize,
          offset,
          totalRows: null,
          rowCount: dataRows.length,
          columns,
          rows: dataRows,
          hasMore,
        }, {
          schemaName,
          tableName,
          pageNumber,
          offset,
          pageSize: this.pageSize,
          rowCount: dataRows.length,
          rows: dataRows,
        });

        offset += pageRows.length;
        if (!hasMore) break;
      }

      console.log(
        `[mysql] table_data ${schemaName}.${tableName} done (${extractedRows} rows, ${pageNumber} pages)`
      );
    }
  }

  async resolveMysqlTables(targets) {
    const filter = this.client.schemaFilter(this.allowedSchemas, "TABLE_SCHEMA");
    const found = [];
    for (const target of targets) {
      const rows = await this.client.query(
        `
        SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
        FROM information_schema.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' ${filter.clause}
          AND TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
        `,
        [...filter.params, target.schemaName, target.tableName]
      );
      if (!rows.length) {
        console.log(
          `[mysql] table_data skipped missing table ${target.schemaName}.${target.tableName}`
        );
        continue;
      }
      found.push(rows[0]);
    }
    return found;
  }

  async *extractChangedRows(schemaName, tableName, window) {
    const column = await this.findModifiedColumn(schemaName, tableName);
    const qualified = `${schemaName}.${tableName}`;
    if (!column) {
      console.log(
        `[mysql] incremental table_data skipped ${qualified}: no datetime modified column. Set MYSQL_MODIFIED_COLUMN.`
      );
      return;
    }

    const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
    const quotedColumn = quoteIdentifier(column);
    const rowFilter = `${quotedColumn} >= ? AND ${quotedColumn} < ?`;
    const filterParams = [sqlDateLiteral(window.since), sqlDateLiteral(window.until)];
    console.log(`[mysql] incremental ${qualified} using ${column}`);

    const tableColumns = await this.client.getTableColumns(schemaName, tableName);
    const pkColumns = await this.primaryKeyColumns(schemaName, tableName);
    const orderColumns = pkColumns.length ? pkColumns : tableColumns;
    const orderBy = orderColumns.length
      ? orderColumns.map((name) => quoteIdentifier(name)).join(", ")
      : "1";

    const totalRowsResult = await this.client.query(
      `SELECT COUNT(*) AS total_rows FROM ${fullTableName} WHERE ${rowFilter}`,
      filterParams
    );
    const totalRows = Number(totalRowsResult[0]?.total_rows || 0);
    let offset = 0;

    while (offset < totalRows) {
      const pageRows = await this.client.query(
        `
        SELECT * FROM ${fullTableName}
        WHERE ${rowFilter}
        ORDER BY ${orderBy}
        LIMIT ${this.pageSize} OFFSET ${offset}
        `,
        filterParams
      );
      if (!pageRows.length) break;

      const columns = tableColumns.length ? tableColumns : Object.keys(pageRows[0] || {});
      for (const row of pageRows) {
        const dataRow = {};
        for (const name of columns) {
          dataRow[name] = serializeValue(row[name]);
        }
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
      SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      `,
      [schemaName, tableName]
    );
    const wanted = this.modifiedColumn ? [this.modifiedColumn] : MODIFIED_COLUMN_NAMES;
    const byName = new Map(rows.map((row) => [String(row.column_name).toLowerCase(), row]));
    for (const name of wanted) {
      const row = byName.get(name.toLowerCase());
      if (!row) continue;
      const dataType = String(row.data_type || "").toLowerCase();
      if (!DATE_TYPES.has(dataType) && !dataType.startsWith("timestamp") && dataType !== "datetime" && dataType !== "date") {
        if (this.modifiedColumn) {
          console.log(
            `[mysql] ${schemaName}.${tableName}.${row.column_name} is ${row.column_type || row.data_type}, not a date column`
          );
        }
        continue;
      }
      return row.column_name;
    }
    return null;
  }

  async primaryKeyColumns(schemaName, tableName) {
    const rows = await this.client.query(
      `
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
      `,
      [schemaName, tableName]
    );
    return rows.map((row) => row.column_name);
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "mysql",
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
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function changeClause(window, alias = "") {
  if (!window) return "";
  const since = sqlDateLiteral(window.since);
  const until = sqlDateLiteral(window.until);
  const prefix = alias ? `${alias}.` : "";
  const createTime = `${prefix}CREATE_TIME`;
  const updateTime = `${prefix}UPDATE_TIME`;
  return `AND (
    (${createTime} >= '${since}' AND ${createTime} < '${until}')
    OR (${updateTime} >= '${since}' AND ${updateTime} < '${until}')
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
