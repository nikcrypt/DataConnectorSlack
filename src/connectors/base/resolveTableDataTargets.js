/**
 * Resolve which schema.table pairs to extract for table_data.
 *
 * Supported env patterns (same for MYSQL_/ORACLE_/POSTGRES_/MSSQL_):
 *   1) SCHEMA + TABLE          → one table
 *   2) SCHEMA + TABLES=a,b,c   → several tables in that schema
 *   3) TABLES=s1.t1,s2.t2      → fully qualified names (SCHEMA optional)
 *
 * @param {{
 *   schema?: string|null,
 *   table?: string|null,
 *   tables?: string|null,
 *   envPrefix: string,
 * }} options
 * @returns {{ schemaName: string, tableName: string }[]}
 */
export function resolveTableDataTargets({ schema, table, tables, envPrefix }) {
  const prefix = envPrefix || "DB";
  const defaultSchema = String(schema || "").trim() || null;
  const singleTable = String(table || "").trim() || null;
  const list = String(tables || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (list.length) {
    return list.map((entry) => parseEntry(entry, defaultSchema, prefix));
  }

  if (defaultSchema && singleTable) {
    return [{ schemaName: defaultSchema, tableName: singleTable }];
  }

  throw new Error(
    `${prefix} table_data requires ${prefix}_SCHEMA + ${prefix}_TABLE, ` +
      `or ${prefix}_TABLES (comma-separated). ` +
      `Examples: ${prefix}_SCHEMA=app ${prefix}_TABLES=orders,customers ` +
      `or ${prefix}_TABLES=app.orders,hr.employees`
  );
}

function parseEntry(entry, defaultSchema, prefix) {
  const separator = entry.indexOf(".");
  if (separator > 0) {
    const schemaName = entry.slice(0, separator).trim();
    const tableName = entry.slice(separator + 1).trim();
    if (!schemaName || !tableName) {
      throw new Error(
        `${prefix}_TABLES entry "${entry}" is invalid. Use TABLE or SCHEMA.TABLE.`
      );
    }
    if (tableName.includes(".")) {
      throw new Error(
        `${prefix}_TABLES entry "${entry}" has too many dots. Use SCHEMA.TABLE only.`
      );
    }
    return { schemaName, tableName };
  }

  if (!defaultSchema) {
    throw new Error(
      `${prefix}_TABLES entry "${entry}" needs a schema. ` +
        `Set ${prefix}_SCHEMA or use SCHEMA.TABLE form.`
    );
  }

  return { schemaName: defaultSchema, tableName: entry };
}
