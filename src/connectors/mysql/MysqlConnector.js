import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { MysqlClient } from "./MysqlClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns"];

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

  async *extract(object) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown MySQL object: ${object}`);
    }

    try {
      switch (object) {
        case "schemas":
          yield* this.extractSchemas();
          break;
        case "tables":
          yield* this.extractTables();
          break;
        case "views":
          yield* this.extractViews();
          break;
        case "columns":
          yield* this.extractColumns();
          break;
        default:
          throw new Error(`Extract not implemented for ${object}`);
      }
    } finally {
      await this.client.disconnect();
    }
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

  async *extractTables() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "TABLE_SCHEMA");
    const rows = await this.client.query(
      `
      SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
      FROM information_schema.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE' ${filter.clause}
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

  async *extractColumns() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "TABLE_SCHEMA");
    const rows = await this.client.query(
      `
      SELECT
        TABLE_SCHEMA AS table_schema,
        TABLE_NAME AS table_name,
        COLUMN_NAME AS column_name,
        ORDINAL_POSITION AS ordinal_position,
        DATA_TYPE AS data_type,
        COLUMN_TYPE AS column_type,
        IS_NULLABLE AS is_nullable,
        COLUMN_DEFAULT AS column_default,
        CHARACTER_MAXIMUM_LENGTH AS character_maximum_length
      FROM information_schema.COLUMNS
      WHERE 1 = 1 ${filter.clause}
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
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
