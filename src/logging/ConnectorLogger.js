class ConnectorLogger {
  constructor(logger) {
    this.logger = logger;
  }

  debug(message, metadata = {}) {
    this.logger.debug(message, metadata);
  }

  info(message, metadata = {}) {
    this.logger.info(message, metadata);
  }

  warn(message, metadata = {}) {
    this.logger.warn(message, metadata);
  }

  error(message, metadata = {}) {
    this.logger.error(message, metadata);
  }

  trackError(err, metadata = {}) {
    this.logger.error(err.message, {
      ...metadata,
      errorType: err.name,
      stack: err.stack
    });
  }

  child(metadata = {}) {
    return new ConnectorLogger(
      this.logger.child(metadata)
    );
  }
}

export default ConnectorLogger;