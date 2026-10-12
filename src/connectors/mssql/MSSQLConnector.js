import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { MSSQLClient } from "./MSSQLClient.js";

const OBJECTS = ["schemas", "tables", "columns", "constraints", "table_data"];

export class MSSQLConnector extends DataConnector {
  constructor(config) {
    super();
    this.client = config.client;
    this.allowedSchemas = config.allowedSchemas?.length ? config.allowedSchemas : null;
    this.pageSize = Number.isFinite(config.pageSize) && config.pageSize > 0
      ? config.pageSize
      : 1000;
    this.schemaName = config.schemaName || null;
    this.tableName = config.tableName || null;
  }

  static fromEnv() {
    const allowedSchemas = process.env.MSSQL_SCHEMAS
      ? process.env.MSSQL_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const explicitSchema = process.env.MSSQL_SCHEMA?.trim() || null;
    const explicitTable = process.env.MSSQL_TABLE?.trim() || null;
    const pageSize = Number(process.env.EXPORT_PAGE_SIZE || process.env.MSSQL_PAGE_SIZE || 1000);

    return new MSSQLConnector({
      client: MSSQLClient.fromEnv(),
      allowedSchemas: allowedSchemas.length ? allowedSchemas : null,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000,
      schemaName: explicitSchema,
      tableName: explicitTable,
    });
  }

  getConnectorKey() {
    return "mssql";
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
      throw new Error(`Unknown MSSQL object: ${object}`);
    }

    try {
      switch (object) {
        case "schemas":
          yield* this.extractSchemas();
          break;
        case "tables":
          yield* this.extractTables();
          break;
        case "columns":
          yield* this.extractColumns();
          break;
        case "constraints":
          yield* this.extractConstraints();
          break;
        case "table_data":
          yield* this.extractTableData();
          break;
        default:
          throw new Error(`Extract not implemented for ${object}`);
      }
    } finally {
      await this.client.disconnect();
    }
  }

  async *extractSchemas() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "s.name");
    const rows = await this.client.query(`
      SELECT s.schema_id AS schema_id, s.name AS schema_name
      FROM sys.schemas s
      WHERE 1 = 1 ${filter.clause}
      ORDER BY s.name
    `);

    for (const row of rows) {
      yield this.record("schemas", row.schema_name, {
        schemaId: row.schema_id,
        schemaName: row.schema_name,
      }, row);
    }
  }

  async *extractTables() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "s.name");
    const rows = await this.client.query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        t.object_id AS object_id,
        t.create_date AS create_date,
        t.modify_date AS modify_date
      FROM sys.tables t
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE t.is_ms_shipped = 0 ${filter.clause}
      ORDER BY s.name, t.name
    `);

    for (const row of rows) {
      const sourceId = `${row.schema_name}.${row.table_name}`;
      yield this.record("tables", sourceId, {
        schemaName: row.schema_name,
        tableName: row.table_name,
        objectId: row.object_id,
        createDate: row.create_date ? new Date(row.create_date).toISOString() : null,
        modifyDate: row.modify_date ? new Date(row.modify_date).toISOString() : null,
      }, row);
    }
  }

  async *extractColumns() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "s.name");
    const rows = await this.client.query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        c.column_id AS column_id,
        c.name AS column_name,
        TYPE_NAME(c.user_type_id) AS data_type,
        TYPE_NAME(c.system_type_id) AS system_data_type,
        c.max_length AS max_length,
        c.precision AS precision,
        c.scale AS scale,
        c.is_nullable AS is_nullable,
        c.is_identity AS is_identity,
        c.is_computed AS is_computed,
        c.is_rowguidcol AS is_rowguidcol,
        dc.definition AS default_definition,
        c.collation_name AS collation_name
      FROM sys.columns c
      INNER JOIN sys.tables t ON c.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
      WHERE t.is_ms_shipped = 0 ${filter.clause}
      ORDER BY s.name, t.name, c.column_id
    `);

    for (const row of rows) {
      const sourceId = `${row.schema_name}.${row.table_name}.${row.column_name}`;
      yield this.record("columns", sourceId, {
        schemaName: row.schema_name,
        tableName: row.table_name,
        columnId: row.column_id,
        columnName: row.column_name,
        dataType: row.data_type,
        systemDataType: row.system_data_type,
        maxLength: row.max_length,
        precision: row.precision,
        scale: row.scale,
        isNullable: row.is_nullable === 1,
        isIdentity: row.is_identity === 1,
        isComputed: row.is_computed === 1,
        isRowGuidColumn: row.is_rowguidcol === 1,
        defaultDefinition: row.default_definition || null,
        collationName: row.collation_name || null,
      }, row);
    }
  }

  async *extractConstraints() {
    const queries = [
      {
        key: "primary_keys",
        sql: `
          SELECT
            sch.name AS schema_name,
            tbl.name AS table_name,
            kc.name AS constraint_name,
            col.name AS column_name,
            ic.key_ordinal AS key_ordinal
          FROM sys.key_constraints kc
          INNER JOIN sys.tables tbl ON kc.parent_object_id = tbl.object_id
          INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
          INNER JOIN sys.indexes idx ON kc.parent_object_id = idx.object_id AND kc.unique_index_id = idx.index_id
          INNER JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
          INNER JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
          WHERE kc.type = 'PK' AND sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys')
          ORDER BY sch.name, tbl.name, ic.key_ordinal
        `,
      },
      {
        key: "foreign_keys",
        sql: `
          SELECT
            sch.name AS schema_name,
            tbl.name AS table_name,
            fk.name AS constraint_name,
            col.name AS column_name,
            refSch.name AS referenced_schema_name,
            refTbl.name AS referenced_table_name,
            refCol.name AS referenced_column_name,
            fkc.constraint_column_id AS constraint_column_id
          FROM sys.foreign_keys fk
          INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
          INNER JOIN sys.tables tbl ON fk.parent_object_id = tbl.object_id
          INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
          INNER JOIN sys.columns col ON fkc.parent_object_id = col.object_id AND fkc.parent_column_id = col.column_id
          INNER JOIN sys.tables refTbl ON fkc.referenced_object_id = refTbl.object_id
          INNER JOIN sys.schemas refSch ON refTbl.schema_id = refSch.schema_id
          INNER JOIN sys.columns refCol ON fkc.referenced_object_id = refCol.object_id AND fkc.referenced_column_id = refCol.column_id
          WHERE sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys')
          ORDER BY sch.name, tbl.name, fk.name, fkc.constraint_column_id
        `,
      },
      {
        key: "unique_constraints",
        sql: `
          SELECT
            sch.name AS schema_name,
            tbl.name AS table_name,
            kc.name AS constraint_name,
            col.name AS column_name,
            ic.key_ordinal AS key_ordinal
          FROM sys.key_constraints kc
          INNER JOIN sys.tables tbl ON kc.parent_object_id = tbl.object_id
          INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
          INNER JOIN sys.indexes idx ON kc.parent_object_id = idx.object_id AND kc.unique_index_id = idx.index_id
          INNER JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
          INNER JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
          WHERE kc.type = 'UQ' AND sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys')
          ORDER BY sch.name, tbl.name, kc.name, ic.key_ordinal
        `,
      },
      {
        key: "check_constraints",
        sql: `
          SELECT
            sch.name AS schema_name,
            tbl.name AS table_name,
            cc.name AS constraint_name,
            cc.definition AS definition,
            cc.is_disabled AS is_disabled
          FROM sys.check_constraints cc
          INNER JOIN sys.tables tbl ON cc.parent_object_id = tbl.object_id
          INNER JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
          WHERE sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys')
          ORDER BY sch.name, tbl.name, cc.name
        `,
      },
    ];

    for (const query of queries) {
      const rows = await this.client.query(query.sql);
      for (const row of rows) {
        const sourceId = `${row.schema_name}.${row.table_name}.${row.constraint_name || row.column_name || query.key}`;
        yield this.record("constraints", sourceId, {
          constraintType: query.key,
          schemaName: row.schema_name,
          tableName: row.table_name,
          constraintName: row.constraint_name || null,
          columnName: row.column_name || null,
          definition: row.definition || null,
          isDisabled: row.is_disabled ?? null,
          keyOrdinal: row.key_ordinal ?? null,
          referencedSchemaName: row.referenced_schema_name || null,
          referencedTableName: row.referenced_table_name || null,
          referencedColumnName: row.referenced_column_name || null,
        }, row);
      }
    }
  }

  async *extractTableData() {
    const filter = this.client.schemaFilter(this.allowedSchemas, "s.name");
    const baseWhere = [];
    if (this.schemaName) {
      baseWhere.push(`s.name = '${this.schemaName.replace(/'/g, "''")}'`);
    }
    if (this.tableName) {
      baseWhere.push(`t.name = '${this.tableName.replace(/'/g, "''")}'`);
    }

    const whereClause = baseWhere.length ? `AND ${baseWhere.join(" AND ")}` : "";

    const tables = await this.client.query(`
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.tables t
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE t.is_ms_shipped = 0 ${filter.clause} ${whereClause}
      ORDER BY s.name, t.name
    `);

    for (const table of tables) {
      const schemaName = table.schema_name;
      const tableName = table.table_name;
      const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
      const tableColumns = await this.client.getTableColumns(schemaName, tableName);
      const orderBy = tableColumns.length
        ? tableColumns.map((column) => quoteIdentifier(column)).join(", ")
        : "1";

      const totalRowsResult = await this.client.query(`SELECT COUNT(*) AS total_rows FROM ${fullTableName}`);
      const totalRows = Number(totalRowsResult[0]?.total_rows || 0);

      let offset = 0;
      let pageNumber = 0;

      while (offset < totalRows) {
        const pageRows = await this.client.query(`
          SELECT * FROM ${fullTableName}
          ORDER BY ${orderBy}
          OFFSET ${offset} ROWS FETCH NEXT ${this.pageSize} ROWS ONLY
        `);

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

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "mssql",
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
  return `[${String(name).replace(/]/g, "]]")}]`;
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
