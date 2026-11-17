/**
 * Base contract every source connector implements.
 * Runtime stays independent of Slack / Postgres / Jira specifics.
 */
export class DataConnector {
  async testConnection() {
    throw new Error("testConnection() not implemented");
  }

  /** @returns {string[]} object names this connector can extract */
  getObjects() {
    throw new Error("getObjects() not implemented");
  }

  /**
   * Objects used when the caller does not pass --objects.
   * Override to keep heavy objects (e.g. table_data) opt-in only.
   * @returns {string[]}
   */
  getDefaultObjects() {
    return this.getObjects();
  }

  /**
   * Async generator: yields one normalised record at a time.
   * @param {string} object
   * @param {object} [options]
   */
  async *extract(object, options = {}) {
    throw new Error("extract() not implemented");
  }

  getSourceId(record, object) {
    throw new Error("getSourceId() not implemented");
  }

  getCheckpoint(object) {
    return null;
  }

  /**
   * Soft-delete policy for Mongo full-run reconciliation.
   * When reconcileOnFull is true, sourceIds not seen in a successful full extract
   * are marked isDeleted=true (tombstoned), not removed.
   * @param {string} object
   * @returns {{ reconcileOnFull: boolean }}
   */
  getSoftDeletePolicy(object) {
    return { reconcileOnFull: false };
  }

  /** @returns {string} e.g. slack, postgres */
  getConnectorKey() {
    return "unknown";
  }
}
