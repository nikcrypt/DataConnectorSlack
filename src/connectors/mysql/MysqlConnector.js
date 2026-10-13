import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { MysqlClient } from "./MysqlClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns"];
const CHECKPOINT_OBJECTS = new Set(["tables", "columns"]);

/**
 * MySQL metadata connector.
 * Extracts schemas, tables, views, and columns from information_schema.
 * Table row data is out of scope for this POC.
 */
export class MysqlConnector extends DataConnector {
  /**
   * @param {{
   *   client: MysqlClient,
   *   allowedSchemas?: string[],
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.allowedSchemas = config.allowedSchemas?.length ? config.allowedSchemas : null;
  }

  static fromEnv() {
    const allowedSchemas = process.env.MYSQL_SCHEMAS
      ? process.env.MYSQL_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    return new MysqlConnector({
      client: MysqlClient.fromEnv(),
      allowedSchemas,
    });
  }

  getConnectorKey() {
    return "mysql";
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
      throw new Error(`Unknown MySQL object: ${object}`);
    }

    try {
      const catalogWindow = object === "schemas" || object === "views"
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
