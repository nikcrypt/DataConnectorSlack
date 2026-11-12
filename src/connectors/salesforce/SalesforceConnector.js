import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { SalesforceClient } from "./SalesforceClient.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import loggerFactory from "../../logger.js";

const logger = loggerFactory.component("Salesforce", {
  connector: "Salesforce"
});

const OBJECTS = ["sobjects", "fields", "records"];

/**
 * Salesforce connector via REST API.
 * - sobjects: object catalog
 * - fields: field metadata from describe (for configured objects)
 * - records: SOQL rows for configured objects
 */
export class SalesforceConnector extends DataConnector {
  /**
   * @param {{
   *   client: SalesforceClient,
   *   sobjectNames?: string[],
   *   recordLimit?: number,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.sobjectNames = config.sobjectNames?.length
      ? config.sobjectNames
      : ["Account", "Contact", "Opportunity"];
    this.recordLimit = config.recordLimit ?? 10000;
  }

  static fromEnv() {
    const sobjectNames = process.env.SALESFORCE_OBJECTS
      ? process.env.SALESFORCE_OBJECTS.split(",").map((s) => s.trim()).filter(Boolean)
      : ["Account", "Contact", "Opportunity"];

    const recordLimit = process.env.SALESFORCE_RECORD_LIMIT
      ? Number(process.env.SALESFORCE_RECORD_LIMIT)
      : 10000;

    return new SalesforceConnector({
      client: SalesforceClient.fromEnv(),
      sobjectNames,
      recordLimit,
    });
  }

  getConnectorKey() {
    return "salesforce";
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
    if (object === "records") return { type: "timestamp" };
    return null;
  }

  async *extract(object, options = {}) {
    logger.info("ExtractionStarted", {
      object,
      incremental: Boolean(options.checkpoint)
    });
    if (!OBJECTS.includes(object)) {
      throw new Error(`Unknown Salesforce object: ${object}`);
    }

    switch (object) {
      case "sobjects":
        yield* this.extractSObjects();
        break;
      case "fields":
        yield* this.extractFields();
        break;
      case "records":
        yield* this.extractRecords(options);
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
    logger.info("ExtractionCompleted", {
      object
    });
  }

  async *extractSObjects() {
    const sobjects = await this.client.listSObjects();
    for (const obj of sobjects) {
      // Skip rarely useful tooling objects in POC unless queryable custom/standard of interest
      yield this.record("sobjects", obj.name, {
        name: obj.name,
        label: obj.label || null,
        labelPlural: obj.labelPlural || null,
        custom: Boolean(obj.custom),
        queryable: Boolean(obj.queryable),
        createable: Boolean(obj.createable),
        updateable: Boolean(obj.updateable),
        deletable: Boolean(obj.deletable),
        keyPrefix: obj.keyPrefix || null,
      }, obj);
    }
  }

  async *extractFields() {
    for (const name of this.sobjectNames) {
      try {
        const describe = await this.client.describeSObject(name);
        for (const field of describe.fields || []) {
          yield this.record(
            "fields",
            `${name}.${field.name}`,
            {
              sobject: name,
              name: field.name,
              label: field.label || null,
              type: field.type || null,
              length: field.length ?? null,
              nillable: Boolean(field.nillable),
              custom: Boolean(field.custom),
              createable: Boolean(field.createable),
              updateable: Boolean(field.updateable),
              unique: Boolean(field.unique),
              externalId: Boolean(field.externalId),
              referenceTo: field.referenceTo || [],
            },
            field
          );
        }
      } catch (err) {
        logger.warn(`[salesforce] fields skipped for ${name}:`, { error: err.message });
      }
    }
  }

  async *extractRecords(options = {}) {
    const window = incrementalWindow(options);
    if (window) {
      logger.info(`[salesforce] incremental records modified from ${window.since.toISOString()} until ${window.until.toISOString()}`);
    }
    logger.info(
      `[salesforce] record limit per object: ${this.recordLimit} (SALESFORCE_RECORD_LIMIT)`
    );

    for (const name of this.sobjectNames) {
      try {
        const describe = await this.client.describeSObject(name);
        if (!describe.queryable) {
          logger.warn(`[salesforce] ${name} is not queryable; skipping records`);
          continue;
        }

        const selected = selectableFieldNames(describe.fields);
        const progress = { count: 0 };
        try {
          yield* this.extractObjectRecords(name, selected, progress, window);
        } catch (err) {
          if (progress.count > 0) {
            logger.warn(
              `[salesforce] ${name} stopped after ${progress.count} records: ${err.message}`
            );
            continue;
          }
          logger.warn(
            `[salesforce] ${name} query failed, retrying with Id and Name: ${err.message}`
          );
          yield* this.extractObjectRecords(name, ["Id", "Name"], progress, window);
        }
        logger.info(`[salesforce] ${name}: fetched ${progress.count} records`);
      } catch (err) {
        logger.warn(`[salesforce] records skipped for ${name}:`, { error: err.message });
      }
    }
  }

  async *extractObjectRecords(name, fieldNames, progress, window = null) {
    const selected = ["Id", ...fieldNames.filter((field) => field !== "Id")];
    const where = window
      ? ` WHERE LastModifiedDate >= ${soqlTime(window.since)} AND LastModifiedDate < ${soqlTime(window.until)}`
      : "";
    const soql = `SELECT ${selected.join(", ")} FROM ${name}${where} LIMIT ${this.recordLimit}`;

    for await (const row of this.client.query(soql)) {
      const { attributes, Id, ...rest } = row;
      yield this.record(
        "records",
        `${name}:${Id || row.Id}`,
        {
          sobject: name,
          id: Id || row.Id || null,
          fields: { Id: Id || row.Id, ...rest },
          type: attributes?.type || name,
        },
        row
      );
      progress.count += 1;
      if (progress.count >= this.recordLimit) return;
    }
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "salesforce",
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

function soqlTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const SKIP_FIELD_TYPES = new Set(["address", "location", "base64", "anytype"]);

/** Compound fields such as BillingAddress cannot appear in SOQL and fail the whole query. */
function selectableFieldNames(fields) {
  const names = [];
  for (const field of fields || []) {
    if (!field?.name || field.name === "Id") continue;
    if (field.queryable === false) continue;
    if (SKIP_FIELD_TYPES.has(String(field.type || "").toLowerCase())) continue;
    names.push(field.name);
  }
  return names;
}
