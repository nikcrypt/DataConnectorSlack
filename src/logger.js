import path from "node:path";
import winston from "winston";
import "winston-daily-rotate-file";
import "winston-mongodb";

const logDir = process.env.LOG_DIR || "data/logs";

const commonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const appTransport = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: "data-connector-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxFiles: "7d",
  level: "info"
});

const errorTransport = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: "error-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxFiles: "7d",
  level: "error"
});

const mongoAppTransport = new winston.transports.MongoDB({
  db: process.env.MONGO_LOGS_URL,
  collection: "application_logs",
  level: "info",
  tryReconnect: true,
  options: {
    maxPoolSize: 10
  },
  metaKey: "metadata"
});

const mongoErrorTransport = new winston.transports.MongoDB({
  db: process.env.MONGO_LOGS_URL,
  collection: "error_logs",
  level: "error",
  tryReconnect: true,
  options: {
    maxPoolSize: 10
  },
  metaKey: "metadata"
});

const rootLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: commonFormat,
  transports: [
  appTransport,
  errorTransport,
  mongoAppTransport,
  mongoErrorTransport
]
});

if (process.env.NODE_ENV !== "production") {
  rootLogger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  );
}

class ConnectorLogger {
  constructor(logger) {
    this.logger = logger;
  }

  child(metadata = {}) {
    return new ConnectorLogger(
      this.logger.child(metadata)
    );
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

  trackError(error, metadata = {}) {
    this.logger.error(error.message, {
      ...metadata,
      errorType: error.name,
      stack: error.stack
    });
  }
}

export class LoggerFactory {
  constructor(baseLogger) {
    this.baseLogger = baseLogger;
  }

  component(componentName, metadata = {}) {
    return new ConnectorLogger(
      this.baseLogger.child({
        component: componentName,
        ...metadata
      })
    );
  }

  connector(connectorName) {
    return new ConnectorLogger(
      this.baseLogger.child({
        connector: connectorName
      })
    );
  }
}

export const loggerFactory =
  new LoggerFactory(rootLogger);

export default loggerFactory;