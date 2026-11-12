import winston from "winston";
import ConnectorLogger from "./ConnectorLogger.js";

const rootLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console()
  ]
});

class LoggerFactory {
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
    return this.component(connectorName, {
      connector: connectorName
    });
  }
}

export const loggerFactory =
  new LoggerFactory(rootLogger);

export default loggerFactory;