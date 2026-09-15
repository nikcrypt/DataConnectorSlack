import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { PostgresClient } from "./PostgresClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns"];

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
    return null;
  }

  async *extract(object, options = {}) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Postgres object: ${object}`);
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

  async *extractTables() {
    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    const sql = `
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' ${filter.clause}
      ORDER BY table_schema, table_name
    `;
    const rows = await this.client.query(sql, filter.params);

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
    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    const sql = `
      SELECT table_schema, table_name
      FROM information_schema.views
      WHERE 1=1 ${filter.clause}
      ORDER BY table_schema, table_name
    `;
    const rows = await this.client.query(sql, filter.params);

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}`;
      yield this.record("views", sourceId, {
        schemaName: row.table_schema,
        viewName: row.table_name,
      }, row);
    }
  }

  async *extractColumns() {
    const filter = this.client.tableSchemaFilter(this.allowedSchemas);
    const sql = `
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
    const rows = await this.client.query(sql, filter.params);

    for (const row of rows) {
      const sourceId = `${row.table_schema}.${row.table_name}.${row.column_name}`;
      yield this.record("columns", sourceId, {
        schemaName: row.table_schema,
        tableName: row.table_name,
        columnName: row.column_name,
        ordinalPosition: row.ordinal_position,
        dataType: row.data_type,
        udtName: row.udt_name,
        nullable: row.is_nullable === "YES",
        defaultValue: row.column_default,
        characterMaxLength: row.character_maximum_length,
      }, row);
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
