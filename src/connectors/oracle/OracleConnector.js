import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { OracleClient } from "./OracleClient.js";

const OBJECTS = ["schemas", "tables", "views", "columns"];

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

  async *extract(object) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Oracle object: ${object}`);
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

  async *extractTables() {
    const filter = this.client.ownerFilter(this.allowedSchemas, "owner");
    const sql = `
      SELECT owner, table_name, tablespace_name, num_rows
      FROM all_tables
      WHERE 1 = 1
      ${filter.clause}
      ORDER BY owner, table_name
    `;
    const rows = await this.client.query(sql, filter.binds);

    for (const row of rows) {
      const sourceId = `${row.OWNER}.${row.TABLE_NAME}`;
      yield this.record("tables", sourceId, {
        schemaName: row.OWNER,
        tableName: row.TABLE_NAME,
        tablespaceName: row.TABLESPACE_NAME || null,
        numRows: row.NUM_ROWS ?? null,
      }, row);
    }
  }

  async *extractViews() {
    const filter = this.client.ownerFilter(this.allowedSchemas, "owner");
    const sql = `
      SELECT owner, view_name
      FROM all_views
      WHERE 1 = 1
      ${filter.clause}
      ORDER BY owner, view_name
    `;
    const rows = await this.client.query(sql, filter.binds);

    for (const row of rows) {
      const sourceId = `${row.OWNER}.${row.VIEW_NAME}`;
      yield this.record("views", sourceId, {
        schemaName: row.OWNER,
        viewName: row.VIEW_NAME,
      }, row);
    }
  }

  async *extractColumns() {
    const filter = this.client.ownerFilter(this.allowedSchemas, "owner");
    // DATA_DEFAULT is a LONG and is omitted — thin-mode fetches of LONG are unreliable.
    const sql = `
      SELECT
        owner,
        table_name,
        column_name,
        column_id,
        data_type,
        data_length,
        data_precision,
        data_scale,
        nullable,
        char_length
      FROM all_tab_columns
      WHERE 1 = 1
      ${filter.clause}
      ORDER BY owner, table_name, column_id
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
