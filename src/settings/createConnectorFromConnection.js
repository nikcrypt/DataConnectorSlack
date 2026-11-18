import { readFileSync } from "node:fs";
import { JiraClient } from "../connectors/jira/JiraClient.js";
import { JiraConnector } from "../connectors/jira/JiraConnector.js";
import { getConnection } from "./connectionsStore.js";

const JIRA_CONFIG_PATH = new URL("../config/connectors/jira.json", import.meta.url);

function loadJiraConfig() {
  return JSON.parse(readFileSync(JIRA_CONFIG_PATH, "utf8"));
}

/**
 * Build a connector instance from a saved connection record (UI registration).
 * Currently supports Jira (email + API token).
 */
export async function createConnectorFromConnection(connectionId) {
  const connection = await getConnection(connectionId);

  if (connection.connector === "jira") {
    return createJiraFromConnection(connection);
  }

  throw Object.assign(
    new Error(`Connector type not supported for connections API: ${connection.connector}`),
    { status: 400 }
  );
}

function createJiraFromConnection(connection) {
  if (!connection.baseUrl || !connection.email || !connection.apiToken) {
    throw Object.assign(
      new Error("Jira connection is missing baseUrl, email, or apiToken"),
      { status: 400 }
    );
  }

  const config = loadJiraConfig();
  const selected = new Set(
    Array.isArray(connection.objects) && connection.objects.length
      ? connection.objects
      : Object.keys(config.objects || {})
  );

  const objects = {};
  for (const [name, definition] of Object.entries(config.objects || {})) {
    objects[name] = {
      ...definition,
      enabled: selected.has(name) && definition.enabled !== false,
    };
  }

  const incremental = config.options?.incremental || {};
  return new JiraConnector({
    client: new JiraClient({
      baseUrl: connection.baseUrl,
      email: connection.email,
      apiToken: connection.apiToken,
    }),
    jql: config.options?.defaultJql,
    jqlValidationEndpoint: config.options?.jqlValidationEndpoint,
    projectKey: config.options?.projectKey,
    incrementalLookbackMinutes: incremental.lookbackMinutes,
    objects,
  });
}
