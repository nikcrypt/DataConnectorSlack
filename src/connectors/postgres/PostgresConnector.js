import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { PostgresClient } from "./PostgresClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns"];
const CHECKPOINT_OBJECTS = new Set(["tables", "views", "columns"]);

/**
 * PostgreSQL metadata connector.
 * Extracts schemas, tables, views, and columns from information_schema.
 * Table row data is out of scope for this POC.
 */
export class PostgresConnector extends DataConnector {
  /**
   * @param {{
   *   client: PostgresClient,
   *   allowedSchemas?: string[],
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.allowedSchemas = config.allowedSchemas?.length ? config.allowedSchemas : null;
  }

  static fromEnv() {
    const allowedSchemas = process.env.POSTGRES_SCHEMAS
      ? process.env.POSTGRES_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    return new PostgresConnector({
      client: PostgresClient.fromEnv(),
      allowedSchemas,
    });
  }

  getConnectorKey() {
    return "postgres";
  }

  getObjects() {
    return [...OBJECTS];
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
      const window = object === "schemas" ? null : incrementalWindow(options);
      if (window) {
        this.clock = await this.modificationClock();
        if (!this.clock) {
          throw new Error(
            "Postgres incremental needs track_commit_timestamp=on, or permission to read relation file times with pg_stat_file."
          );
        }
        console.log(
          `[postgres] incremental catalog changes from ${window.since.toISOString()} until ${window.until.toISOString()}`
        );
      }
      switch (object) {
        case "schemas":
          yield* this.extractSchemas();
          break;
        case "tables":
          yield* this.extractTables(window);
          break;
        case "views":
          yield* this.extractViews(window);
          break;
        case "columns":
          yield* this.extractColumns(window);
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
