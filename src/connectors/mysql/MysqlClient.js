import mysql from "mysql2/promise";

const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

/**
 * MySQL client for catalog queries via information_schema.
 * Extracts metadata the connected user can see — not table row data.
 */
export class MysqlClient {
  /**
   * @param {{
   *   host: string,
   *   port?: number,
   *   user: string,
   *   password: string,
   *   database?: string,
   *   ssl?: boolean,
   * }} config
   */
  constructor(config) {
    if (!config.host || !config.user || config.password == null) {
      throw new Error(
        "Missing MySQL config. Set MYSQL_URL or MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD."
      );
    }
    this.config = {
      host: config.host,
      port: config.port ?? 3306,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    };
    this.connection = null;
  }

  static fromEnv() {
    if (process.env.MYSQL_URL) {
      return new MysqlClient(configFromUrl(process.env.MYSQL_URL));
    }

    return new MysqlClient({
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      ssl: process.env.MYSQL_SSL === "true",
    });
  }

  async connect() {
    if (this.connection) return this.connection;
    this.connection = await mysql.createConnection(this.config);
    return this.connection;
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  /**
   * @param {string} sql
   * @param {Array<string|number>} [params]
   */
  async query(sql, params = []) {
    const connection = await this.connect();
    const [rows] = await connection.query(sql, params);
    return rows;
  }

  async testConnection() {
    const rows = await this.query(
      "SELECT DATABASE() AS database_name, CURRENT_USER() AS session_user, VERSION() AS version"
    );
    const row = rows[0] || {};
    return {
      ok: true,
      database: row.database_name || null,
      user: row.session_user || null,
      version: row.version || null,
      host: this.config.host,
    };
  }

  /**
   * @param {string[]|null} allowedSchemas
   * @param {string} column
   */
  schemaFilter(allowedSchemas, column) {
    if (allowedSchemas?.length) {
      const placeholders = allowedSchemas.map(() => "?").join(", ");
      return {
        clause: `AND ${column} IN (${placeholders})`,
        params: allowedSchemas,
      };
    }
    const placeholders = SYSTEM_SCHEMAS.map(() => "?").join(", ");
    return {
      clause: `AND ${column} NOT IN (${placeholders})`,
      params: [...SYSTEM_SCHEMAS],
    };
  }
}

function configFromUrl(raw) {
  const url = new URL(raw);
  const ssl =
    process.env.MYSQL_SSL === "true" ||
    /(?:^|[?&])ssl=true(?:&|$)/i.test(url.search);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || undefined,
    ssl,
  };
}
