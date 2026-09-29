import oracledb from "oracledb";

/**
 * Oracle catalog client.
 * Uses node-oracledb thin mode (no Instant Client) against ALL_* views.
 * Extracts metadata the connected user can see — not table row data.
 */

const SYSTEM_OWNERS = [
  "SYS",
  "SYSTEM",
  "OUTLN",
  "DBSNMP",
  "APPQOSSYS",
  "AUDSYS",
  "CTXSYS",
  "DVSYS",
  "DVF",
  "GSMADMIN_INTERNAL",
  "GSMCATUSER",
  "GSMUSER",
  "LBACSYS",
  "MDSYS",
  "OJVMSYS",
  "OLAPSYS",
  "ORDDATA",
  "ORDSYS",
  "WMSYS",
  "XDB",
  "SYSMAN",
  "SYSBACKUP",
  "SYSDG",
  "SYSKM",
  "SYSRAC",
  "XS$NULL",
  "GGSYS",
  "REMOTE_SCHEDULER_AGENT",
  "DIP",
  "ORACLE_OCM",
  "DBSFWUSER",
  "MDDATA",
  "APEX_PUBLIC_USER",
];

const SYSTEM_OWNER_SQL = `
  AND owner NOT IN (${SYSTEM_OWNERS.map((name) => `'${name}'`).join(", ")})
  AND owner NOT LIKE 'APEX\\_%' ESCAPE '\\'
  AND owner NOT LIKE 'FLOWS\\_%' ESCAPE '\\'
`;

export class OracleClient {
  /**
   * @param {{
   *   user: string,
   *   password: string,
   *   connectString: string,
   * }} config
   */
  constructor(config) {
    if (!config.user || !config.password || !config.connectString) {
      throw new Error(
        "Missing Oracle config. Set ORACLE_USER, ORACLE_PASSWORD, and ORACLE_CONNECT_STRING " +
          "(or ORACLE_HOST + ORACLE_SERVICE_NAME / ORACLE_SID)."
      );
    }
    this.user = config.user;
    this.password = config.password;
    this.connectString = config.connectString;
    this.connection = null;
  }

  static fromEnv() {
    return new OracleClient({
      user: process.env.ORACLE_USER,
      password: process.env.ORACLE_PASSWORD,
      connectString: connectStringFromEnv(),
    });
  }

  async connect() {
    if (this.connection) return this.connection;
    this.connection = await oracledb.getConnection({
      user: this.user,
      password: this.password,
      connectString: this.connectString,
    });
    return this.connection;
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }

  /**
   * @param {string} sql
   * @param {Record<string, string|number>} [binds]
   */
  async query(sql, binds = {}) {
    const connection = await this.connect();
    const result = await connection.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return result.rows || [];
  }

  async testConnection() {
    const rows = await this.query(`
      SELECT
        SYS_CONTEXT('USERENV', 'DB_NAME') AS database_name,
        SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS service_name,
        SYS_CONTEXT('USERENV', 'SESSION_USER') AS session_user,
        SYS_CONTEXT('USERENV', 'SERVER_HOST') AS server_host
      FROM dual
    `);
    const row = rows[0] || {};
    return {
      ok: true,
      database: row.DATABASE_NAME || null,
      serviceName: row.SERVICE_NAME || null,
      user: row.SESSION_USER || null,
      host: row.SERVER_HOST || null,
      connectString: this.connectString,
    };
  }

  /**
   * @param {string[]|null} allowedSchemas
   * @param {string} column  owner column name
   */
  ownerFilter(allowedSchemas, column = "owner") {
    if (allowedSchemas?.length) {
      const binds = {};
      const placeholders = allowedSchemas.map((schema, index) => {
        const key = `s${index}`;
        binds[key] = schema.toUpperCase();
        return `:${key}`;
      });
      return {
        clause: `AND ${column} IN (${placeholders.join(", ")})`,
        binds,
      };
    }
    return { clause: SYSTEM_OWNER_SQL.replaceAll("owner", column), binds: {} };
  }
}

function connectStringFromEnv() {
  if (process.env.ORACLE_CONNECT_STRING) {
    return process.env.ORACLE_CONNECT_STRING;
  }

  const host = process.env.ORACLE_HOST;
  const port = process.env.ORACLE_PORT || "1521";
  const service = process.env.ORACLE_SERVICE_NAME;
  const sid = process.env.ORACLE_SID;

  if (host && service) return `${host}:${port}/${service}`;
  if (host && sid) {
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${sid})))`;
  }
  return "";
}
