import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { PostgresClient } from "./PostgresClient.js";

const METADATA_OBJECTS = ["schemas", "tables", "views", "columns"];
const OBJECTS = [...METADATA_OBJECTS, "table_data"];
const CHECKPOINT_OBJECTS = new Set(["tables", "views", "columns", "table_data"]);
const DATE_TYPES = new Set([
  "date",
  "timestamp without time zone",
  "timestamp with time zone",
  "timestamp",
  "timestamptz",
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
 * PostgreSQL connector.
 * Default objects are catalog metadata (information_schema).
 * Optional object `table_data` reads actual table rows (paginated).
 */
export class PostgresConnector extends DataConnector {
  /**
   * @param {{
   *   client: PostgresClient,
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
    this.clock = undefined;
  }

  static fromEnv() {
    const allowedSchemas = process.env.POSTGRES_SCHEMAS
      ? process.env.POSTGRES_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const pageSize = Number(process.env.EXPORT_PAGE_SIZE || process.env.POSTGRES_PAGE_SIZE || 1000);

    return new PostgresConnector({
      client: PostgresClient.fromEnv(),
      allowedSchemas,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000,
      schemaName: process.env.POSTGRES_SCHEMA?.trim() || null,
      tableName: process.env.POSTGRES_TABLE?.trim() || null,
      modifiedColumn: process.env.POSTGRES_MODIFIED_COLUMN?.trim() || null,
    });
  }

  getConnectorKey() {
    return "postgres";
  }

  getObjects() {
    return [...OBJECTS];
  }

  /** Metadata only — table_data is opt-in via --objects table_data */
  getDefaultObjects() {
    return [...METADATA_OBJECTS];
  }

  async testConnection() {
    return this.client.testConnection();
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
      throw new Error(`Unknown Postgres object: ${object}`);
    }

    try {
      const catalogWindow = object === "schemas" || object === "table_data"
        ? null
        : incrementalWindow(options);
      if (catalogWindow) {
        this.clock = await this.modificationClock();
        if (!this.clock) {
          throw new Error(
            "Postgres incremental needs track_commit_timestamp=on, or permission to read relation file times with pg_stat_file."
          );
        }
        console.log(
          `[postgres] incremental catalog changes from ${catalogWindow.since.toISOString()} until ${catalogWindow.until.toISOString()}`
        );
      }
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

  async modificationClock() {
    if (this.clock !== undefined) return this.clock;
    const rows = await this.client.query(
      "SELECT current_setting('track_commit_timestamp') AS enabled"
    );
    if (String(rows[0]?.enabled || "").toLowerCase() === "on") {
      console.log("[postgres] incremental uses transaction commit times");
      return "commit";
    }
    try {
      await this.client.query(`
        SELECT (pg_stat_file(path)).modification
        FROM (
          SELECT pg_relation_filepath(oid) AS path
          FROM pg_class
          WHERE relkind = 'r' AND pg_relation_filepath(oid) IS NOT NULL
          LIMIT 1
        ) files
      `);
      console.log(
        "[postgres] incremental uses relation file modification times. Turn track_commit_timestamp on to include view changes."
      );
      return "file";
    } catch (error) {
      const message = String(error?.message || error);
      if (/permission denied|must be superuser|pg_read_server_files/i.test(message)) return null;
      throw error;
    }
  }

  async *extractSchemas() {
    const filter = this.client.schemaFilter(this.allowedSchemas);
    const sql = `
      SELECT schema_name, catalog_name
      FROM information_schema.schemata
      WHERE 1=1 ${filter.clause}
      ORDER BY schema_name
    `;
    const rows = await this.client.query(sql, filter.params);

    for (const row of rows) {
      yield this.record("schemas", row.schema_name, {
        schemaName: row.schema_name,
        catalogName: row.catalog_name,
      }, row);
    }
  }

  async *extractTables(window = null) {
    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    const timed = windowParams(filter, window);
    const modified = window ? modifiedExpr(this.clock, "table") : null;
    const sql = window
      ? `
      SELECT t.table_schema, t.table_name, t.table_type, ${modified} AS modified_at
      FROM information_schema.tables t
      JOIN pg_namespace n ON n.nspname = t.table_schema
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name AND c.relkind IN ('r', 'p')
      WHERE t.table_type = 'BASE TABLE' ${qualifySchema(timed.clause, "t")}
        AND ${modifiedPredicate(this.clock, timed.since, timed.until, "table")}
      ORDER BY t.table_schema, t.table_name
      `
      : `
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' ${filter.clause}
      ORDER BY table_schema, table_name
      `;
    const rows = await this.client.query(sql, window ? timed.params : filter.params);

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}`;
      yield this.record("tables", sourceId, withModifiedAt({
        schemaName: row.table_schema,
        tableName: row.table_name,
        tableType: row.table_type,
      }, row.modified_at), row);
    }
  }

  async *extractViews(window = null) {
    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    if (window && this.clock !== "commit") {
      console.log("[postgres] incremental views skipped: relation files do not change when a view definition changes.");
      return;
    }
    const timed = windowParams(filter, window);
    const modified = window ? modifiedExpr(this.clock, "view") : null;
    const sql = window
      ? `
      SELECT v.table_schema, v.table_name, ${modified} AS modified_at
      FROM information_schema.views v
      JOIN pg_namespace n ON n.nspname = v.table_schema
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = v.table_name AND c.relkind = 'v'
      JOIN pg_rewrite r ON r.ev_class = c.oid AND r.rulename = '_RETURN'
      WHERE 1=1 ${qualifySchema(timed.clause, "v")}
        AND ${modifiedPredicate(this.clock, timed.since, timed.until, "view")}
      ORDER BY v.table_schema, v.table_name
      `
      : `
      SELECT table_schema, table_name
      FROM information_schema.views
      WHERE 1=1 ${filter.clause}
      ORDER BY table_schema, table_name
      `;
    const rows = await this.client.query(sql, window ? timed.params : filter.params);

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}`;
      yield this.record("views", sourceId, withModifiedAt({
        schemaName: row.table_schema,
        viewName: row.table_name,
      }, row.modified_at), row);
    }
  }

  async *extractColumns(window = null) {
    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    const timed = windowParams(filter, window);
    const modified = window ? modifiedExpr(this.clock, "column") : null;
    if (window && this.clock === "file") {
      console.log("[postgres] incremental columns follow the table file modification time.");
    }
    const sql = window
      ? `
      SELECT
        cols.table_schema,
        cols.table_name,
        cols.column_name,
        cols.ordinal_position,
        cols.data_type,
        cols.udt_name,
        cols.is_nullable,
        cols.column_default,
        cols.character_maximum_length,
        ${modified} AS modified_at
      FROM information_schema.columns cols
      JOIN pg_namespace n ON n.nspname = cols.table_schema
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = cols.table_name AND c.relkind IN ('r', 'p', 'v')
      LEFT JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = cols.column_name AND a.attnum > 0 AND NOT a.attisdropped
      WHERE 1=1 ${qualifySchema(timed.clause, "cols")}
        AND ${modifiedPredicate(this.clock, timed.since, timed.until, "column")}
      ORDER BY cols.table_schema, cols.table_name, cols.ordinal_position
      `
      : `
      SELECT
        table_schema,
        table_name,
        column_name,
        ordinal_position,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE 1=1 ${filter.clause}
      ORDER BY table_schema, table_name, ordinal_position
      `;
    const rows = await this.client.query(sql, window ? timed.params : filter.params);

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}.${row.column_name}`;
      yield this.record("columns", sourceId, withModifiedAt({
        schemaName: row.table_schema,
        tableName: row.table_name,
        columnName: row.column_name,
        ordinalPosition: row.ordinal_position,
        dataType: row.data_type,
        udtName: row.udt_name,
        nullable: row.is_nullable === "YES",
        defaultValue: row.column_default,
        characterMaxLength: row.character_maximum_length,
      }, row.modified_at), row);
    }
  }

  /**
   * Read actual table rows (paginated).
   * Requires POSTGRES_SCHEMA + POSTGRES_TABLE.
   */
  async *extractTableData(options = {}) {
    if (!this.schemaName || !this.tableName) {
      throw new Error(
        "Postgres table_data requires POSTGRES_SCHEMA and POSTGRES_TABLE in .env " +
          "(example: POSTGRES_SCHEMA=public, POSTGRES_TABLE=orders)."
      );
    }

    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    const params = [...filter.params, this.schemaName, this.tableName];
    const schemaParam = `$${filter.params.length + 1}`;
    const tableParam = `$${filter.params.length + 2}`;

    const tables = await this.client.query(
      `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' ${filter.clause}
        AND table_schema = ${schemaParam}
        AND table_name = ${tableParam}
      ORDER BY table_schema, table_name
      `,
      params
    );

    if (!tables.length) {
      throw new Error(
        `Postgres table not found or not visible: ${this.schemaName}.${this.tableName}`
      );
    }

    const window = incrementalWindow(options);
    if (window) {
      console.log(
        `[postgres] incremental table rows modified from ${window.since.toISOString()} until ${window.until.toISOString()}`
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
        `[postgres] table_data ${schemaName}.${tableName} pageSize=${this.pageSize} orderBy=${orderColumns.join(",") || "1"}`
      );

      let offset = 0;
      let pageNumber = 0;
      let extractedRows = 0;

      while (true) {
        const pageRows = await this.client.query(
          `
          SELECT * FROM ${fullTableName}
          ORDER BY ${orderBy}
          LIMIT $1 OFFSET $2
          `,
          [this.pageSize, offset]
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
        `[postgres] table_data ${schemaName}.${tableName} done (${extractedRows} rows, ${pageNumber} pages)`
      );
    }
  }

  async *extractChangedRows(schemaName, tableName, window) {
    const column = await this.findModifiedColumn(schemaName, tableName);
    const qualified = `${schemaName}.${tableName}`;
    if (!column) {
      console.log(
        `[postgres] incremental table_data skipped ${qualified}: no timestamp modified column. Set POSTGRES_MODIFIED_COLUMN.`
      );
      return;
    }

    const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
    const quotedColumn = quoteIdentifier(column);
    console.log(`[postgres] incremental ${qualified} using ${column}`);

    const tableColumns = await this.client.getTableColumns(schemaName, tableName);
    const pkColumns = await this.primaryKeyColumns(schemaName, tableName);
    const orderColumns = pkColumns.length ? pkColumns : tableColumns.slice(0, 1);
    const orderBy = orderColumns.length
      ? orderColumns.map((name) => quoteIdentifier(name)).join(", ")
      : "1";

    let offset = 0;

    while (true) {
      const pageRows = await this.client.query(
        `
        SELECT * FROM ${fullTableName}
        WHERE ${quotedColumn} >= $1::timestamptz AND ${quotedColumn} < $2::timestamptz
        ORDER BY ${orderBy}
        LIMIT $3 OFFSET $4
        `,
        [window.since.toISOString(), window.until.toISOString(), this.pageSize, offset]
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
          totalRows: null,
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
      if (pageRows.length < this.pageSize) break;
    }
  }

  async findModifiedColumn(schemaName, tableName) {
    const rows = await this.client.query(
      `
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      `,
      [schemaName, tableName]
    );
    const wanted = this.modifiedColumn ? [this.modifiedColumn] : MODIFIED_COLUMN_NAMES;
    const byName = new Map(rows.map((row) => [String(row.column_name).toLowerCase(), row]));
    for (const name of wanted) {
      const row = byName.get(name.toLowerCase());
      if (!row) continue;
      const dataType = String(row.data_type || "").toLowerCase();
      const udt = String(row.udt_name || "").toLowerCase();
      const isDate = DATE_TYPES.has(dataType) || udt === "timestamp" || udt === "timestamptz" || udt === "date";
      if (!isDate) {
        if (this.modifiedColumn) {
          console.log(
            `[postgres] ${schemaName}.${tableName}.${row.column_name} is ${row.data_type}, not a timestamp column`
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
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      INNER JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
      ORDER BY kcu.ordinal_position
      `,
      [schemaName, tableName]
    );
    return rows.map((row) => row.column_name);
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "postgres",
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

function windowParams(filter, window) {
  if (!window) return { clause: filter.clause, params: filter.params, since: null, until: null };
  return {
    clause: filter.clause,
    params: [...filter.params, window.since.toISOString(), window.until.toISOString()],
    since: `$${filter.params.length + 1}::timestamptz`,
    until: `$${filter.params.length + 2}::timestamptz`,
  };
}

function qualifySchema(clause, alias) {
  return clause.replaceAll("table_schema", `${alias}.table_schema`);
}

function modifiedExpr(clock, target) {
  if (clock === "commit" && target === "view") {
    return "GREATEST(pg_xact_commit_timestamp(c.xmin), pg_xact_commit_timestamp(r.xmin))";
  }
  if (clock === "commit" && target === "column") return "pg_xact_commit_timestamp(a.xmin)";
  if (clock === "commit") return "pg_xact_commit_timestamp(c.xmin)";
  return "(pg_stat_file(pg_relation_filepath(c.oid))).modification";
}

function modifiedPredicate(clock, since, until, target) {
  if (clock === "commit" && target === "column") {
    return `pg_xact_commit_timestamp(a.xmin) >= ${since} AND pg_xact_commit_timestamp(a.xmin) < ${until}`;
  }
  if (clock === "commit") {
    const expr = modifiedExpr(clock, target);
    return `${expr} >= ${since} AND ${expr} < ${until}`;
  }
  return `c.relkind = 'r' AND pg_relation_filepath(c.oid) IS NOT NULL AND (pg_stat_file(pg_relation_filepath(c.oid))).modification >= ${since} AND (pg_stat_file(pg_relation_filepath(c.oid))).modification < ${until}`;
}

function withModifiedAt(data, value) {
  const modifiedAt = isoDate(value);
  if (modifiedAt) data.modifiedAt = modifiedAt;
  return data;
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
