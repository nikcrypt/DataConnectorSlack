import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { SalesforceClient } from "./SalesforceClient.js";

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
    this.recordLimit = config.recordLimit ?? 200;
  }

  static fromEnv() {
    const sobjectNames = process.env.SALESFORCE_OBJECTS
      ? process.env.SALESFORCE_OBJECTS.split(",").map((s) => s.trim()).filter(Boolean)
      : ["Account", "Contact", "Opportunity"];

    const recordLimit = process.env.SALESFORCE_RECORD_LIMIT
      ? Number(process.env.SALESFORCE_RECORD_LIMIT)
      : 200;

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

  async *extract(object) {
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
        yield* this.extractRecords();
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
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
        console.warn(`[salesforce] fields skipped for ${name}:`, err.message);
      }
    }
  }

  async *extractRecords() {
    for (const name of this.sobjectNames) {
      try {
        const describe = await this.client.describeSObject(name);
        if (!describe.queryable) {
          console.warn(`[salesforce] ${name} is not queryable; skipping records`);
          continue;
        }

        const fieldNames = (describe.fields || [])
          .map((f) => f.name)
          .filter(Boolean);

        // Keep SOQL manageable for POC — Id + up to 25 fields
        const selected = ["Id", ...fieldNames.filter((f) => f !== "Id")].slice(0, 26);
        const soql = `SELECT ${selected.join(", ")} FROM ${name} LIMIT ${this.recordLimit}`;

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
        }
      } catch (err) {
        console.warn(`[salesforce] records skipped for ${name}:`, err.message);
      }
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
