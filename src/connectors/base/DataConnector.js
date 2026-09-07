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
}
