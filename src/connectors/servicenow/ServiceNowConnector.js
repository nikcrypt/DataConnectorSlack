import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DataConnector } from "../base/DataConnector.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import { ServiceNowClient, readValue } from "./ServiceNowClient.js";

const CONFIG_PATH = new URL("../../config/connectors/servicenow.json", import.meta.url);

const BOOLEAN_FIELDS = new Set(["active", "known_error", "major_problem"]);
const DATE_FIELDS = new Set([
  "opened_at",
  "resolved_at",
  "closed_at",
  "start_date",
  "end_date",
  "work_start",
  "work_end",
  "sys_created_on",
  "sys_updated_on",
]);

export class ServiceNowConnector extends DataConnector {
  constructor(config) {
    super();
    this.client = config.client;
    this.objects = config.objects;
    this.fieldMode = readFieldMode(config.fieldMode);
    this.objectFieldModes = {};
    for (const [objectName, definition] of Object.entries(this.objects)) {
      this.objectFieldModes[objectName] = definition.fieldMode === undefined
        ? this.fieldMode
        : readFieldMode(definition.fieldMode, objectName);
    }
    this.includeCustomFields = config.includeCustomFields ?? true;
    this.customFieldPrefixes = config.customFieldPrefixes || ["u_", "x_"];
    this.incrementalField = config.incrementalField || "sys_updated_on";
    if (!/^[a-zA-Z0-9_]+$/.test(this.incrementalField)) {
      throw new Error("ServiceNow incremental field is invalid");
    }
    this.incrementalLookbackMinutes = readLookbackMinutes(
      config.incrementalLookbackMinutes,
    );
  }

  static fromEnv() {
    const config = loadConfig();
    const options = config.options || {};
    const customFields = options.customFields || {};
    const incremental = options.incremental || {};
    const customFieldPrefixes = readCustomFieldPrefixes(customFields.prefixes);
    const includeCustomFields = process.env.SERVICENOW_CUSTOM_FIELD_MODE
      ? process.env.SERVICENOW_CUSTOM_FIELD_MODE !== "none"
      : customFields.enabled !== false;

    return new ServiceNowConnector({
      client: ServiceNowClient.fromEnv(options),
      objects: config.objects,
      fieldMode: options.fieldMode,
      includeCustomFields,
      customFieldPrefixes,
      incrementalField: incremental.field,
      incrementalLookbackMinutes: incremental.lookbackMinutes,
    });
  }

  getConnectorKey() {
    return "servicenow";
  }

  getObjects() {
    return Object.entries(this.objects)
      .filter(([, definition]) => definition.enabled !== false)
      .map(([name]) => name);
  }

  testConnection() {
    return this.client.testConnection();
  }

  getSourceId(record) {
    return record.sourceId;
  }

  getCheckpoint(object) {
    const definition = this.objects[object];
    if (!definition || definition.enabled === false) return null;
    return { type: "timestamp", field: this.incrementalField };
  }

  async *extract(object, options = {}) {
    const definition = this.objects[object];
    if (!definition || definition.enabled === false) {
      throw new Error(`Unknown ServiceNow object: ${object}`);
    }

    const window = incrementalWindow(options);
    if (options.mode === "incremental" && !window) {
      throw new Error(
        `Incremental ServiceNow extraction requires a valid checkpoint for ${object}`,
      );
    }
    if (window && window.since >= window.until) {
      throw new Error(`ServiceNow incremental checkpoint is not before the run start for ${object}`);
    }

    const extractionWindow = applyLookback(
      window,
      this.incrementalLookbackMinutes,
    );
    const query = buildTableQuery(
      definition.filter,
      this.incrementalField,
      extractionWindow,
    );

    if (extractionWindow) {
      console.log(
        `[servicenow] incremental ${object} updated from ${extractionWindow.since.toISOString()} until ${extractionWindow.until.toISOString()}`,
      );
    }

    const fieldMode = this.objectFieldModes[object];
    const fields = fieldMode === "configured"
      ? Object.keys(definition.fields)
      : undefined;

    for await (const rawRecord of this.client.paginateTable(definition.table, {
      fields,
      query,
    })) {
      const sourceId = readValue(rawRecord.sys_id);
      if (!sourceId) {
        throw new Error(`ServiceNow ${definition.table} record has no sys_id`);
      }

      const data = this.mapRecord(rawRecord, definition.fields, fieldMode);
      yield this.createRecord(object, sourceId, data, rawRecord);
    }
  }

  mapRecord(rawRecord, fieldMappings, fieldMode = this.fieldMode) {
    const data = {};

    for (const [source, target] of Object.entries(fieldMappings)) {
      data[target] = convertKnownField(source, rawRecord[source]);
    }

    if (this.includeCustomFields && fieldMode === "all") {
      for (const [name, value] of Object.entries(rawRecord)) {
        const isCustomField = this.customFieldPrefixes.some((prefix) =>
          name.startsWith(prefix),
        );
        const alreadyMapped = Object.hasOwn(fieldMappings, name);
        if (isCustomField && !alreadyMapped) {
          data[`custom_${name}`] = normalizeValue(value);
        }
      }
    }

    return data;
  }

  createRecord(object, sourceId, data, rawData) {
    const record = {
      connectorKey: "servicenow",
      object,
      sourceId: String(sourceId),
      data,
      rawData,
      isDeleted: false,
      extractedAt: new Date().toISOString(),
    };
    record.hash = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    return record;
  }
}

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (config.connector !== "servicenow" || !config.objects) {
    throw new Error("Invalid ServiceNow connector config");
  }
  return config;
}

function readCustomFieldPrefixes(configuredPrefixes) {
  if (process.env.SERVICENOW_CUSTOM_FIELD_PREFIXES) {
    return process.env.SERVICENOW_CUSTOM_FIELD_PREFIXES.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return Array.isArray(configuredPrefixes) && configuredPrefixes.length
    ? configuredPrefixes
    : ["u_", "x_"];
}

function readLookbackMinutes(value) {
  if (value === undefined || value === null || value === "") return 0;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error("ServiceNow incremental lookbackMinutes must be a non-negative integer");
  }
  return minutes;
}

function readFieldMode(value, objectName) {
  const mode = value === undefined
    ? "all"
    : String(value).trim().toLowerCase();
  if (mode !== "configured" && mode !== "all") {
    const location = objectName ? ` for ${objectName}` : "";
    throw new Error(`ServiceNow fieldMode${location} must be "configured" or "all"`);
  }
  return mode;
}

function applyLookback(window, lookbackMinutes) {
  if (!window || lookbackMinutes === 0) return window;
  return {
    since: new Date(window.since.getTime() - lookbackMinutes * 60 * 1000),
    until: window.until,
  };
}

function buildTableQuery(baseFilter, field, window) {
  if (!window) return baseFilter || "";
  const updatedWithinWindow = [
    `${field}>=${serviceNowTime(window.since)}`,
    `${field}<${serviceNowTime(window.until)}`,
  ].join("^");
  return [baseFilter, updatedWithinWindow].filter(Boolean).join("^");
}

function serviceNowTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function convertKnownField(name, input) {
  const value = normalizeValue(input);
  if (value === null || value === "") return null;

  if (BOOLEAN_FIELDS.has(name)) {
    return value === true || value === "true" || value === "1";
  }

  if (DATE_FIELDS.has(name)) {
    const text = String(value).replace(" ", "T");
    const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
    const date = new Date(hasTimeZone ? text : `${text}Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return value;
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && "value" in value) {
    return normalizeValue(value.value);
  }
  return value;
}
