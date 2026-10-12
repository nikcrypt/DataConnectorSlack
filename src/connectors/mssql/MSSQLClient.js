import sql from "mssql";

const SYSTEM_SCHEMAS = ["guest", "INFORMATION_SCHEMA", "sys"];

export class MSSQLClient {
  constructor(config) {
    if (!config.server || !config.user || config.password == null || !config.database) {
      throw new Error(
        "Missing MSSQL config. Set MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD, and MSSQL_DATABASE."
      );
    }

    this.config = {
      server: config.server,
      port: config.port ?? 1433,
      user: config.user,
      password: config.password,
      database: config.database,
      encrypt: config.encrypt ?? false,
      trustServerCertificate: config.trustServerCertificate ?? true,
      options: {
        encrypt: config.encrypt ?? false,
        trustServerCertificate: config.trustServerCertificate ?? true,
      },
      pool: {
        max: config.pool?.max ?? 10,
        min: config.pool?.min ?? 0,
        idleTimeoutMillis: config.pool?.idleTimeoutMillis ?? 30000,
      },
      requestTimeout: config.requestTimeout ?? 0,
    };
    this.pool = null;
  }

  static fromEnv() {
    return new MSSQLClient({
      server: process.env.MSSQL_HOST,
      port: process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : 1433,
      user: process.env.MSSQL_USER,
      password: process.env.MSSQL_PASSWORD,
      database: process.env.MSSQL_DATABASE,
      encrypt: process.env.MSSQL_ENCRYPT === "true",
      trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE !== "false",
      pool: {
        max: Number(process.env.MSSQL_POOL_MAX || 10),
        min: Number(process.env.MSSQL_POOL_MIN || 0),
        idleTimeoutMillis: Number(process.env.MSSQL_IDLE_TIMEOUT || 30000),
      },
      requestTimeout: Number(process.env.MSSQL_REQUEST_TIMEOUT || 0),
    });
  }

  async connect() {
    if (this.pool) return this.pool;
    this.pool = await sql.connect(this.config);
    return this.pool;
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  async query(sqlText) {
    const pool = await this.connect();
    const result = await pool.request().query(sqlText);
    return result.recordset;
  }

  async getTableColumns(schemaName, tableName) {
    const rows = await this.query(`
      SELECT c.name AS column_name
      FROM sys.columns c
      INNER JOIN sys.tables t ON c.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${String(schemaName || "").replace(/'/g, "''")}'
        AND t.name = '${String(tableName || "").replace(/'/g, "''")}'
      ORDER BY c.column_id
    `);
    return rows.map((row) => row.column_name);
  }

  async testConnection() {
    const rows = await this.query(`
      SELECT
        DB_NAME() AS database_name,
        SUSER_SNAME() AS login_name,
        USER_NAME() AS user_name,
        @@SERVERNAME AS server_name,
        HOST_NAME() AS host_name,
        GETDATE() AS current_datetime,
        @@VERSION AS version
    `);
    const row = rows[0] || {};

    return {
      ok: true,
      database: row.database_name || null,
      server: row.server_name || null,
      login: row.login_name || null,
      user: row.user_name || null,
      host: row.host_name || null,
      currentDateTime: row.current_datetime || null,
      version: row.version || null,
    };
  }

  schemaFilter(allowedSchemas, columnName = "schema_name") {
    if (allowedSchemas?.length) {
      const values = allowedSchemas.map((schema) => `'${schema.replace(/'/g, "''")}'`).join(", ");
      return {
        clause: `AND ${columnName} IN (${values})`,
      };
    }

    const values = SYSTEM_SCHEMAS.map((schema) => `'${schema.replace(/'/g, "''")}'`).join(", ");
    return {
      clause: `AND ${columnName} NOT IN (${values})`,
    };
  }
}
