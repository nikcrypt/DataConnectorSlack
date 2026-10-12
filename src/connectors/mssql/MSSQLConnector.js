import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { MSSQLClient } from "./MSSQLClient.js";

const OBJECTS = ["schemas", "tables", "columns", "constraints", "table_data"];
const CHECKPOINT_OBJECTS = new Set(["tables", "columns", "constraints", "table_data"]);
const DATE_TYPES = new Set(["datetime", "datetime2", "datetimeoffset", "smalldatetime", "date"]);
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
];

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
    this.modifiedColumn = config.modifiedColumn || null;
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
      modifiedColumn: process.env.MSSQL_MODIFIED_COLUMN?.trim() || null,
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

  getCheckpoint(object) {
    if (CHECKPOINT_OBJECTS.has(object)) return { type: "timestamp" };
    return null;
  }

  async *extract(object, options = {}) {
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown MSSQL object: ${object}`);
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
        case "columns":
          yield* this.extractColumns(catalogWindow);
          break;
        case "constraints":
          yield* this.extractConstraints(catalogWindow);
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

  async *extractTables(window = null) {
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
      WHERE t.is_ms_shipped = 0 ${filter.clause} ${changeClause(window, "t")}
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

  async *extractColumns(window = null) {
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
      WHERE t.is_ms_shipped = 0 ${filter.clause} ${changeClause(window, "t")}
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

  async *extractConstraints(window = null) {
    const filter = this.client.schemaFilter(this.allowedSchemas, "sch.name");
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
          WHERE kc.type = 'PK' AND sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys') ${filter.clause} ${changeClause(window, "kc")}
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
          WHERE sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys') ${filter.clause} ${changeClause(window, "fk")}
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
          WHERE kc.type = 'UQ' AND sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys') ${filter.clause} ${changeClause(window, "kc")}
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
          WHERE sch.name NOT IN ('guest','INFORMATION_SCHEMA','sys') ${filter.clause} ${changeClause(window, "cc")}
          ORDER BY sch.name, tbl.name, cc.name
        `,
      },
    ];

    for (const query of queries) {
      const rows = await this.client.query(query.sql);
      for (const row of rows) {
        const columnPart = row.column_name || "constraint";
        const ordinal = row.key_ordinal ?? row.constraint_column_id ?? "";
        const sourceId = [
          row.schema_name,
          row.table_name,
          row.constraint_name || query.key,
          columnPart,
          ordinal,
        ].filter((part) => part !== "" && part != null).join(".");
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

  async *extractTableData(options = {}) {
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

    const window = incrementalWindow(options);
    if (!window && !this.schemaName && !this.tableName) {
      console.log("[mssql] table_data will read every user table. Set MSSQL_SCHEMA and MSSQL_TABLE to limit it.");
    }
    if (window) {
      console.log(`[mssql] incremental table rows modified from ${window.since.toISOString()} until ${window.until.toISOString()}`);
    }

    for (const table of tables) {
      const schemaName = table.schema_name;
      const tableName = table.table_name;
      if (window) {
        yield* this.extractChangedRows(schemaName, tableName, window);
        continue;
      }
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

  async catalogWindow(options) {
    const window = incrementalWindow(options);
    if (!window) return null;
    const rows = await this.client.query(`
      SELECT DATEDIFF(MINUTE, SYSUTCDATETIME(), SYSDATETIME()) AS offset_minutes
    `);
    const offsetMs = Number(rows[0]?.offset_minutes || 0) * 60 * 1000;
    console.log(
      `[mssql] incremental catalog changes from ${window.since.toISOString()} until ${window.until.toISOString()}`
    );
    return {
      since: new Date(window.since.getTime() + offsetMs),
      until: new Date(window.until.getTime() + offsetMs),
    };
  }

  async *extractChangedRows(schemaName, tableName, window) {
    const column = await this.findModifiedColumn(schemaName, tableName);
    const qualified = `${schemaName}.${tableName}`;
    if (!column) {
      console.log(
        `[mssql] incremental table_data skipped ${qualified}: no datetime modified column. Set MSSQL_MODIFIED_COLUMN.`
      );
      return;
    }

    const fullTableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
    const quotedColumn = quoteIdentifier(column);
    const rowFilter = `${quotedColumn} >= '${sqlDateLiteral(window.since)}' AND ${quotedColumn} < '${sqlDateLiteral(window.until)}'`;
    console.log(`[mssql] incremental ${qualified} using ${column}`);

    const tableColumns = await this.client.getTableColumns(schemaName, tableName);
    const pkColumns = await this.primaryKeyColumns(schemaName, tableName);
    const orderColumns = pkColumns.length ? pkColumns : tableColumns;
    const orderBy = orderColumns.length
      ? orderColumns.map((name) => quoteIdentifier(name)).join(", ")
      : "1";
    const totalRowsResult = await this.client.query(
      `SELECT COUNT(*) AS total_rows FROM ${fullTableName} WHERE ${rowFilter}`
    );
    const totalRows = Number(totalRowsResult[0]?.total_rows || 0);
    let offset = 0;

    while (offset < totalRows) {
      const pageRows = await this.client.query(`
        SELECT * FROM ${fullTableName}
        WHERE ${rowFilter}
        ORDER BY ${orderBy}
        OFFSET ${offset} ROWS FETCH NEXT ${this.pageSize} ROWS ONLY
      `);
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
    const rows = await this.client.query(`
      SELECT c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type
      FROM sys.columns c
      INNER JOIN sys.tables t ON c.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${escapeLiteral(schemaName)}'
        AND t.name = '${escapeLiteral(tableName)}'
    `);
    const wanted = this.modifiedColumn ? [this.modifiedColumn] : MODIFIED_COLUMN_NAMES;
    const byName = new Map(rows.map((row) => [String(row.column_name).toLowerCase(), row]));
    for (const name of wanted) {
      const row = byName.get(name.toLowerCase());
      if (!row) continue;
      if (!DATE_TYPES.has(String(row.data_type).toLowerCase())) {
        if (this.modifiedColumn) {
          console.log(
            `[mssql] ${schemaName}.${tableName}.${row.column_name} is ${row.data_type}, not a date column`
          );
        }
        continue;
      }
      return row.column_name;
    }
    return null;
  }

  async primaryKeyColumns(schemaName, tableName) {
    const rows = await this.client.query(`
      SELECT col.name AS column_name
      FROM sys.indexes i
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
      INNER JOIN sys.tables t ON i.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE i.is_primary_key = 1
        AND s.name = '${escapeLiteral(schemaName)}'
        AND t.name = '${escapeLiteral(tableName)}'
      ORDER BY ic.key_ordinal
    `);
    return rows.map((row) => row.column_name);
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

function escapeLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function changeClause(window, alias) {
  if (!window) return "";
  const since = sqlDateLiteral(window.since);
  const until = sqlDateLiteral(window.until);
  return `AND ((${alias}.modify_date >= '${since}' AND ${alias}.modify_date < '${until}') OR (${alias}.create_date >= '${since}' AND ${alias}.create_date < '${until}'))`;
}

function sqlDateLiteral(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
  return `${day} ${time}`;
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
