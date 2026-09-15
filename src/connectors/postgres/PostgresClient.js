import pg from "pg";

const { Client } = pg;

/**
 * Thin PostgreSQL client for catalog queries via information_schema.
 */
export class PostgresClient {
  /**
   * @param {object} config
   */
  constructor(config) {
    if (config.connectionString) {
      this.config = {
        connectionString: config.connectionString,
        application_name: "data-connector-postgres",
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      };
    } else {
      this.config = {
        host: config.host,
        port: config.port ?? 5432,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        application_name: "data-connector-postgres",
      };
    }
    this.client = null;
  }

  static fromEnv() {
    // Aiven and most managed Postgres need TLS. Prefer explicit ssl config
    // over sslmode=verify-full behavior in newer pg URL parsing.
    const sslEnabled =
      process.env.POSTGRES_SSL === "true" ||
      /sslmode=require/i.test(process.env.POSTGRES_URL || "");

    if (process.env.POSTGRES_URL) {
      // Strip sslmode from URL; we set ssl on the client instead
      const url = process.env.POSTGRES_URL.replace(/[?&]sslmode=[^&]*/i, "").replace(/\?$/, "");
      return new PostgresClient({
        connectionString: url,
        ssl: sslEnabled,
      });
    }

    const host = process.env.POSTGRES_HOST;
    const database = process.env.POSTGRES_DATABASE;
    const user = process.env.POSTGRES_USER;
    const password = process.env.POSTGRES_PASSWORD;

    if (!host || !database || !user || !password) {
      throw new Error(
        "Missing Postgres config. Set POSTGRES_URL or POSTGRES_HOST, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD in .env"
      );
    }

    return new PostgresClient({
      host,
      port: process.env.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : 5432,
      database,
      user,
      password,
      ssl: sslEnabled,
    });
  }

  async connect() {
    if (this.client) return this.client;
    this.client = new Client(this.config);
    await this.client.connect();
    return this.client;
  }

  async disconnect() {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  async query(sql, params = []) {
    const client = await this.connect();
    const result = await client.query(sql, params);
    return result.rows;
  }

  async testConnection() {
    const rows = await this.query(
      "SELECT current_database() AS database, current_user AS user, version()"
    );
    return {
      ok: true,
      database: rows[0]?.database,
      user: rows[0]?.user,
      version: rows[0]?.version?.split("\n")[0] || null,
    };
  }

  schemaFilter(allowedSchemas) {
    if (allowedSchemas?.length) {
      return {
        clause: "AND schema_name = ANY($1::text[])",
        params: [allowedSchemas],
      };
    }
    return {
      clause: "AND schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')",
      params: [],
    };
  }

  tableSchemaFilter(allowedSchemas) {
    if (allowedSchemas?.length) {
      return {
        clause: "AND table_schema = ANY($1::text[])",
        params: [allowedSchemas],
      };
    }
    return {
      clause: "AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')",
      params: [],
    };
  }
}
