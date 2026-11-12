import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DataConnector } from "../base/DataConnector.js";
import { JiraClient } from "./JiraClient.js";
import { incrementalWindow } from "../base/incrementalWindow.js";
import loggerFactory from "../../logger.js";

const logger = loggerFactory.component("Jira", {
  connector: "Jira"
});
const CONFIG_PATH = new URL("../../config/connectors/jira.json", import.meta.url);
const SUPPORTED_OBJECTS = ["projects", "issues", "users", "statuses", "issueTypes"];
const BOOLEAN_FIELDS = new Set(["isPrivate", "active", "subtask"]);
const ARRAY_FIELDS = new Set(["fields.labels"]);
const MAX_CUSTOM_JQL_LENGTH = 10_000;
const UPDATED_FIELDS = new Set(["updated", "updateddate"]);

/**
 * Jira Cloud connector.
 * Auth: email + API token (Basic).
 */
export class JiraConnector extends DataConnector {
  /**
   * @param {{
   *   client: JiraClient,
   *   jql?: string,
   *   customJql?: string | null,
   *   jqlValidationEndpoint?: string,
   *   projectKey?: string | null,
   *   cliProjectKey?: string | null,
   *   incrementalLookbackMinutes?: number,
   *   objects?: Record<string, {
   *     enabled?: boolean,
   *     endpoint?: string,
   *     pageSize?: number,
   *     fields?: Record<string, string>,
   *   }>,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.jql = config.jql || "ORDER BY updated DESC";
    this.customJql = config.customJql ?? null;
    this.jqlValidationEndpoint = config.jqlValidationEndpoint ?? "/rest/api/3/jql/parse";
    this.preparedJql = null;
    this.projectDiscovery = null;
    this.issueExecution = null;
    if (this.customJql !== null) {
      if (typeof this.customJql !== "string" || !this.customJql.trim()) {
        throw new Error("Jira custom JQL must be a non-empty string");
      }
      this.customJql = this.customJql.trim();
      if (this.customJql.length > MAX_CUSTOM_JQL_LENGTH) {
        throw new Error(`Jira custom JQL must not exceed ${MAX_CUSTOM_JQL_LENGTH} characters`);
      }
      if (typeof this.jqlValidationEndpoint !== "string" || !this.jqlValidationEndpoint.startsWith("/rest/")) {
        throw new Error("Jira JQL validation endpoint must be a relative /rest/ path");
      }
    }
    this.projectKey = normalizeProjectKey(config.projectKey);
    this.cliProjectKey = normalizeProjectKey(config.cliProjectKey);
    this.incrementalLookbackMinutes = readLookbackMinutes(
      config.incrementalLookbackMinutes,
    );
    this.objects = config.objects || loadConfig().objects;

    if (Array.isArray(this.objects) || typeof this.objects !== "object") {
      throw new Error("Jira objects config must be an object");
    }

    for (const [objectName, definition] of Object.entries(this.objects)) {
      if (!SUPPORTED_OBJECTS.includes(objectName)) {
        throw new Error(`Unsupported Jira object in config: ${objectName}`);
      }
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw new Error(`Jira ${objectName} config must be an object`);
      }
      if (definition.enabled !== undefined && typeof definition.enabled !== "boolean") {
        throw new Error(`Jira ${objectName}: enabled must be true or false`);
      }
      if (typeof definition.endpoint !== "string"
        || !definition.endpoint.startsWith("/rest/")) {
        throw new Error(`Jira ${objectName}: endpoint must be a relative /rest/ path`);
      }
      if (definition.pageSize !== undefined
        && (!Number.isInteger(definition.pageSize) || definition.pageSize < 1)) {
        throw new Error(`Jira ${objectName}: pageSize must be a positive integer`);
      }
      if (!definition.fields
        || typeof definition.fields !== "object"
        || Array.isArray(definition.fields)) {
        throw new Error(`Jira ${objectName}: fields must be an object`);
      }

      const targets = new Set();
      for (const [source, target] of Object.entries(definition.fields)) {
        if (!source.trim() || typeof target !== "string" || !target.trim()) {
          throw new Error(`Jira ${objectName}: field mappings must use non-empty names`);
        }
        if (targets.has(target)) {
          throw new Error(`Jira ${objectName}: duplicate target field ${target}`);
        }
        targets.add(target);
      }
    }
  }

  static fromEnv(options = {}) {
    const config = loadConfig();
    const incremental = config.options?.incremental || {};
    return new JiraConnector({
      client: JiraClient.fromEnv(),
      jql: config.options?.defaultJql,
      customJql: options.jql,
      cliProjectKey: options.projectKey,
      jqlValidationEndpoint: config.options?.jqlValidationEndpoint,
      projectKey: firstProjectKey(
        options.projectKey,
        process.env.JIRA_PROJECT_KEY,
        config.options?.projectKey,
      ),
      incrementalLookbackMinutes: incremental.lookbackMinutes,
      objects: config.objects,
    });
  }

  getConnectorKey() {
    return "jira";
  }

  getObjects() {
    return Object.entries(this.objects)
      .filter(([, definition]) => definition.enabled !== false)
      .map(([name]) => name);
  }

  async testConnection() {
    return this.client.testConnection();
  }

  async prepareCustomJql() {
    this.preparedJql = null;
    if (this.customJql === null) return null;

    const customStructure = await this.client.parseJql(this.jqlValidationEndpoint, this.customJql);
    const hasProject = hasProjectCondition(customStructure.where);
    if (hasProject && this.cliProjectKey) {
      throw new Error("Specify the project either through --project-key or inside --jql, not both");
    }
    const projectKey = hasProject ? null : this.projectKey;
    const custom = splitJql(this.customJql);
    const configured = splitJql(this.jql);
    const filters = [];
    if (projectKey) filters.push(`project = "${projectKey}"`);
    if (configured.filter) filters.push(`(${configured.filter})`);
    if (custom.filter) filters.push(`(${custom.filter})`);
    if (!filters.length) {
      throw new Error("Custom JQL requires a filter or a configured project key");
    }

    const filter = filters.join(" AND ");
    const orderBy = custom.orderBy || configured.orderBy || "ORDER BY updated DESC";
    const structure = await this.client.parseJql(
      this.jqlValidationEndpoint,
      `${filter} ${orderBy}`,
    );
    const fingerprint = createHash("sha256").update(filter).digest("hex");
    this.preparedJql = {
      filter,
      orderBy,
      projectKey,
      scope: `project:${projectKey || "all"}|jql:${fingerprint}`,
      ...classifyJqlCheckpoint(structure.where),
    };
    return this.preparedJql;
  }

  validateExtractionMode(mode) {
    if (mode !== "full" && mode !== "incremental") {
      throw new Error("Jira extraction mode must be full or incremental");
    }
    if (mode === "incremental" && this.usesProjectDiscovery() && splitJql(this.jql).filter) {
      throw new Error("All-project incremental extraction requires an unfiltered defaultJql; use --jql for filtered extraction");
    }
    if (this.customJql === null) return;
    if (!this.preparedJql) {
      throw new Error("Custom JQL must be validated before extraction");
    }
    if (mode === "incremental" && this.preparedJql.checkpointPolicy === "skip") {
      throw new Error(`${this.preparedJql.checkpointReason}; use full mode for this query`);
    }
  }

  usesProjectDiscovery() {
    return this.customJql === null && this.projectKey === null;
  }

  buildIssueJql(window = null, projectKey = this.projectKey) {
    if (this.customJql === null) {
      return jiraIssueJql(this.jql, projectKey, window);
    }
    if (!this.preparedJql) {
      throw new Error("Custom JQL must be validated before building an issue query");
    }
    if (window && this.preparedJql.checkpointPolicy === "skip") {
      throw new Error(`${this.preparedJql.checkpointReason}; use full mode for this query`);
    }
    const filters = [this.preparedJql.filter];
    if (window) {
      filters.push(`updated >= ${window.since.getTime()} AND updated < ${window.until.getTime()}`);
    }
    return `${filters.join(" AND ")} ${this.preparedJql.orderBy}`;
  }

  getIssueExtractionQuery(options = {}, projectKey = this.projectKey) {
    this.validateExtractionMode(options.mode ?? "full");
    const checkpointWindow = incrementalWindow(options);
    if (options.mode === "incremental" && !checkpointWindow) {
      throw new Error("Incremental Jira extraction requires a valid issues checkpoint");
    }
    if (this.usesProjectDiscovery() && checkpointWindow) {
      const until = options.checkpoint?.until || options.startedAt;
      if ((until && Number.isNaN(new Date(until).getTime()))
        || checkpointWindow.since > checkpointWindow.until) {
        throw new Error("All-project Jira extraction requires a valid checkpoint time window");
      }
    }
    const window = applyLookback(checkpointWindow, this.incrementalLookbackMinutes);
    return { jql: this.buildIssueJql(window, projectKey), window };
  }

  getExtractionMetadata(object, options = {}) {
    if (object !== "issues" || this.objects.issues?.enabled === false) return null;

    const metadata = {
      requestedJql: this.customJql,
      effectiveJql: null,
      scope: this.getCheckpointScope(object),
      checkpointPolicy: this.getCheckpoint(object) === null ? "skip" : "track",
      checkpointReason: this.preparedJql?.checkpointReason ?? null,
      incrementalWindow: null,
    };
    if (this.usesProjectDiscovery()) {
      this.validateExtractionMode(options.mode ?? "full");
      const execution = this.issueExecution?.startedAt === options.startedAt
        ? this.issueExecution
        : null;
      metadata.queryMode = "per-project";
      metadata.jqlTemplate = this.buildIssueJql(null, "<PROJECT_KEY>");
      metadata.checkpointReason = splitJql(this.jql).filter
        ? "All-project checkpoint tracking requires an unfiltered defaultJql"
        : null;
      metadata.projects = execution ? execution.projects.map((project) => ({ ...project })) : [];
      metadata.missingProjects = execution ? execution.missingProjects.map((project) => ({ ...project })) : [];
      metadata.discoveryComplete = this.projectDiscovery?.startedAt === options.startedAt
        && this.projectDiscovery?.complete === true;
    }
    // Preserve the request before the runtime loads or checks its checkpoint.
    if (options.mode === "incremental" && !options.checkpoint) return metadata;

    if (this.usesProjectDiscovery() && options.mode === "incremental") {
      readCheckpointProjects(options.checkpoint);
    }
    const { jql, window } = this.getIssueExtractionQuery(
      options,
      this.usesProjectDiscovery() ? "<PROJECT_KEY>" : this.projectKey,
    );
    if (this.usesProjectDiscovery()) metadata.jqlTemplate = jql;
    else metadata.effectiveJql = jql;
    metadata.incrementalWindow = windowMetadata(window, this.incrementalLookbackMinutes);
    return metadata;
  }

  getSourceId(record) {
    return record.sourceId;
  }

  getCheckpoint(object) {
    if (object === "issues" && this.objects.issues?.enabled !== false) {
      if (this.usesProjectDiscovery() && splitJql(this.jql).filter) return null;
      if (this.customJql !== null) {
        if (!this.preparedJql) {
          throw new Error("Custom JQL must be validated before checkpoint lookup");
        }
        if (this.preparedJql.checkpointPolicy === "skip") return null;
      }
      return { type: "timestamp" };
    }
    return null;
  }

  getCheckpointScope(object) {
    if (object !== "issues") return null;
    if (this.usesProjectDiscovery()) {
      const filter = splitJql(this.jql).filter;
      return filter
        ? `all-projects|jql:${createHash("sha256").update(filter).digest("hex")}`
        : "all-projects";
    }
    if (this.customJql === null) return this.projectKey;
    if (!this.preparedJql) {
      throw new Error("Custom JQL must be validated before checkpoint lookup");
    }
    return this.preparedJql.scope;
  }

  getNextCheckpoint(object) {
    if (object !== "issues" || !this.usesProjectDiscovery()) return null;
    const execution = this.issueExecution;
    if (!execution?.complete || !this.projectDiscovery?.complete
      || execution.startedAt !== this.projectDiscovery.startedAt) {
      throw new Error("Jira all-project extraction did not finish; checkpoint cannot advance");
    }
    return {
      state: {
        version: 1,
        projects: execution.projects.map(({ id, key }) => ({ id, key })),
      },
    };
  }

  usesRuntimeHashing() {
    return true;
  }

  requiresRunGuard() {
    return true;
  }

  async *extract(object, options = {}) {
    logger.info("ExtractionStarted", {
      object,
      incremental: Boolean(options.checkpoint)
    });
    if (this.customJql !== null && object !== "issues") {
      throw new Error("Custom JQL can only be used when extracting Jira issues");
    }
    const definition = this.objects[object];
    if (!definition || definition.enabled === false) {
      throw new Error(`Unknown Jira object: ${object}`);
    }

    switch (object) {
      case "projects":
        yield* this.extractProjects(definition, options);
        break;
      case "issues":
        yield* this.extractIssues(definition, options);
        break;
      case "users":
        yield* this.extractUsers(definition);
        break;
      case "statuses":
        yield* this.extractStatuses(definition);
        break;
      case "issueTypes":
        yield* this.extractIssueTypes(definition);
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
    logger.info("ExtractionCompleted", {
      object
    });
  }

  async *readProjects(options = {}) {
    const definition = this.objects.projects;
    if (!definition) {
      throw new Error("Jira project discovery requires the projects endpoint configuration");
    }
    const discovery = {
      startedAt: options.startedAt,
      projects: new Map(),
      complete: false,
    };
    this.projectDiscovery = discovery;
    for await (const project of this.client.paginate(
      definition.endpoint,
      "values",
      {},
      definition.pageSize || 50
    )) {
      const id = project?.id;
      const key = normalizeProjectKey(project?.key);
      if (id == null || !String(id).trim() || !key) {
        throw new Error("Jira project discovery returned a project without an id or key");
      }
      if (discovery.projects.has(String(id))) {
        throw new Error(`Jira project discovery returned duplicate project id ${id}`);
      }
      discovery.projects.set(String(id), { id: String(id), key });
      yield project;
    }
    discovery.complete = true;
  }

  async *getIssueProjects(options = {}) {
    const discovery = this.projectDiscovery;
    if (options.startedAt && discovery?.complete && discovery.startedAt === options.startedAt) {
      yield* discovery.projects.values();
      return;
    }
    for await (const project of this.readProjects(options)) {
      yield { id: String(project.id), key: normalizeProjectKey(project.key) };
    }
  }

  async *extractProjects(definition, options = {}) {
    for await (const project of this.readProjects(options)) {
      yield this.record(
        "projects",
        project.id || project.key,
        this.mapRecord(project, definition.fields),
        project
      );
    }
  }

  async *extractIssues(definition, options = {}) {
    if (this.usesProjectDiscovery()) {
      yield* this.extractAllProjectIssues(definition, options);
      return;
    }
    const { jql, window } = this.getIssueExtractionQuery(options);
    const projectKey = this.customJql === null ? this.projectKey : this.preparedJql.projectKey;
    if (projectKey) {
      logger.info(`[jira] extracting issues for project ${projectKey}`);
    }
    if (window) {
      logger.info(`[jira] incremental issues updated from ${window.since.toISOString()} until ${window.until.toISOString()}`);
    }
    yield* this.extractIssuesForQuery(definition, jql);
  }

  async *extractAllProjectIssues(definition, options = {}) {
    const mode = options.mode ?? "full";
    this.validateExtractionMode(mode);
    const previousProjects = mode === "incremental"
      ? readCheckpointProjects(options.checkpoint)
      : new Map();
    this.getIssueExtractionQuery(options, "<PROJECT_KEY>");
    const execution = {
      startedAt: options.startedAt,
      projects: [],
      missingProjects: [],
      complete: false,
    };
    this.issueExecution = execution;

    for await (const project of this.getIssueProjects(options)) {
      const projectMode = mode === "incremental" && previousProjects.has(project.id)
        ? "incremental"
        : "full";
      const { jql, window } = this.getIssueExtractionQuery(
        { ...options, mode: projectMode },
        project.key,
      );
      const result = {
        ...project,
        mode: projectMode,
        effectiveJql: jql,
        incrementalWindow: windowMetadata(window, this.incrementalLookbackMinutes),
        status: "running",
        extracted: 0,
      };
      execution.projects.push(result);
      logger.info(`[jira] extracting issues for project ${project.key} (${projectMode})`);
      try {
        for await (const record of this.extractIssuesForQuery(definition, jql)) {
          result.extracted += 1;
          yield record;
        }
        result.status = "succeeded";
      } catch (error) {
        result.status = "failed";
        result.error = error.message;
        logger.trackError(error, { object: "issues", projectKey: project.key });
        throw new Error(`Jira issues for project ${project.key} failed: ${error.message}`, { cause: error });
      } finally {
        if (result.status === "running") result.status = "interrupted";
      }
    }

    const currentIds = new Set(execution.projects.map((project) => project.id));
    execution.missingProjects = [...previousProjects.values()]
      .filter((project) => !currentIds.has(project.id));
    if (execution.projects.length === 0 && previousProjects.size > 0) {
      throw new Error("Jira returned no projects previously covered by the checkpoint; verify source access before retrying");
    }
    if (execution.missingProjects.length) {
      logger.warn(`[jira] ${execution.missingProjects.length} previously covered projects are no longer visible; stored issues were not marked deleted`);
    }
    if (execution.projects.length === 0) logger.info("[jira] no accessible projects found");
    execution.complete = true;
  }

  async *extractIssuesForQuery(definition, jql) {
    const requestedFields = issueRequestFields(definition.fields);
    for await (const issue of this.client.searchIssues(
      definition.endpoint,
      jql,
      requestedFields,
      definition.pageSize || 50,
      { method: this.customJql === null ? "GET" : "POST" },
    )) {
      const sourceId = issue?.id || issue?.key;
      if (!sourceId) {
        throw new Error("Jira issue response contains an issue without an id or key");
      }

      yield this.record(
        "issues",
        sourceId,
        this.mapRecord(issue, definition.fields),
        issue
      );
    }
  }

  async *extractUsers(definition) {
    // /rest/api/3/users/search returns a bare array (needs Browse users permission)
    let startAt = 0;
    const pageSize = definition.pageSize || 50;

    while (true) {
      let users = [];
      try {
        const page = await this.client.request(definition.endpoint, {
          query: { query: ".", startAt, maxResults: pageSize },
        });
        users = Array.isArray(page) ? page : page.values || [];
      } catch (err) {
        logger.warn("[jira] users extract skipped:", { error: err.message });
        return;
      }

      for (const user of users) {
        if (user.accountType === "app") continue;
        yield this.record(
          "users",
          user.accountId,
          this.mapRecord(user, definition.fields),
          user
        );
      }

      startAt += users.length;
      if (!users.length || users.length < pageSize) break;
    }
  }

  async *extractStatuses(definition) {
    const statuses = await this.client.request(definition.endpoint);
    const list = Array.isArray(statuses) ? statuses : [];
    for (const status of list) {
      yield this.record(
        "statuses",
        status.id,
        this.mapRecord(status, definition.fields),
        status
      );
    }
  }

  async *extractIssueTypes(definition) {
    const types = await this.client.request(definition.endpoint);
    const list = Array.isArray(types) ? types : [];
    for (const type of list) {
      yield this.record(
        "issueTypes",
        type.id,
        this.mapRecord(type, definition.fields),
        type
      );
    }
  }

  mapRecord(rawRecord, fieldMappings) {
    const data = {};
    for (const [source, target] of Object.entries(fieldMappings)) {
      const value = readPath(rawRecord, source);
      data[target] = convertField(source, value);
    }
    return data;
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "jira",
      object,
      sourceId: String(sourceId),
      data,
      rawData: raw ?? null,
      isDeleted: false,
      extractedAt: new Date().toISOString(),
    };
    payload.hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    return payload;
  }
}

function readCheckpointProjects(checkpoint) {
  const state = checkpoint?.state;
  if (!state || state.version !== 1 || !Array.isArray(state.projects)) {
    throw new Error("All-project Jira incremental extraction requires a checkpoint with project state; run a full extraction first");
  }
  const projects = new Map();
  for (const project of state.projects) {
    if (!project || typeof project.id !== "string" || !project.id.trim()
      || typeof project.key !== "string" || !project.key.trim()
      || projects.has(project.id)) {
      throw new Error("Jira checkpoint project state is invalid; run a full extraction first");
    }
    projects.set(project.id, { id: project.id, key: normalizeProjectKey(project.key) });
  }
  return projects;
}

function windowMetadata(window, lookbackMinutes) {
  return window ? {
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    lookbackMinutes,
  } : null;
}

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function issueRequestFields(fieldMappings) {
  return [...new Set(
    Object.keys(fieldMappings)
      .filter((source) => source.startsWith("fields."))
      .map((source) => source.split(".")[1])
  )];
}

function readPath(record, path) {
  return path.split(".").reduce(
    (value, key) => value == null ? undefined : value[key],
    record
  );
}

function convertField(source, value) {
  if (source === "fields.description") return extractPlainText(value);
  if (BOOLEAN_FIELDS.has(source)) return Boolean(value);
  if (ARRAY_FIELDS.has(source)) return Array.isArray(value) ? value : [];
  return value === undefined || value === null || value === "" ? null : value;
}

function splitJql(jql) {
  const text = String(jql || "").trim();
  const ordering = /\bORDER\s+BY\b/iy;
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    ordering.lastIndex = i;
    if (depth === 0 && ordering.test(text)) {
      return { filter: text.slice(0, i).trim(), orderBy: text.slice(i).trim() };
    }
  }
  return { filter: text, orderBy: null };
}

function hasProjectCondition(where) {
  const nodes = [where];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== "object") continue;
    if (typeof node.field?.name === "string"
      && node.field.name.toLowerCase() === "project") {
      return true;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) nodes.push(...value);
      else if (value && typeof value === "object") nodes.push(value);
    }
  }
  return false;
}

function classifyJqlCheckpoint(where) {
  const nodes = [where];
  let hasField = false;
  let checkpointReason = null;
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== "object") continue;
    if (node.field) {
      const name = node.field.name;
      const field = typeof name === "string" ? name.toLowerCase() : "";
      if (!field) {
        checkpointReason ||= "Jira returned an unrecognized filter field";
      } else {
        hasField = true;
      }
      if (["filter", "request", "savedfilter", "searchrequest"].includes(field)) {
        throw new Error("Saved filters are not supported in custom JQL; provide the full JQL conditions");
      }
      if (UPDATED_FIELDS.has(field)) {
        checkpointReason ||= "Custom JQL filters by updated";
      }
    }
    if (node.function) {
      checkpointReason ||= "Custom JQL uses a function whose conditions are not inspected";
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) nodes.push(...value);
      else if (value && typeof value === "object") nodes.push(value);
    }
  }
  if (!hasField) checkpointReason ||= "Jira did not return a recognized filter condition";
  return { checkpointPolicy: checkpointReason ? "skip" : "track", checkpointReason };
}

function jiraIssueJql(baseJql, projectKey, window) {
  if (!projectKey && !window) return baseJql;

  const filters = [];
  const withoutOrder = stripOrderBy(baseJql);
  if (withoutOrder) filters.push(`(${withoutOrder})`);
  if (projectKey) filters.push(`project = "${projectKey}"`);
  if (window) {
    filters.push(
      `updated >= ${window.since.getTime()} AND updated < ${window.until.getTime()}`
    );
  }

  const orderBy = window ? "ORDER BY updated DESC" : readOrderBy(baseJql);
  return `${filters.join(" AND ")} ${orderBy || "ORDER BY updated DESC"}`;
}

function stripOrderBy(jql) {
  return String(jql || "").replace(/\bORDER\s+BY[\s\S]*$/i, "").trim();
}

function readOrderBy(jql) {
  return String(jql || "").match(/\bORDER\s+BY[\s\S]*$/i)?.[0]?.trim() || null;
}

function firstProjectKey(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || null;
}

function normalizeProjectKey(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("Jira project key must be a string");
  }

  const projectKey = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*$/.test(projectKey)) {
    throw new Error(`Invalid Jira project key: ${value}`);
  }
  return projectKey;
}

function readLookbackMinutes(value) {
  if (value === undefined || value === null || value === "") return 0;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error("Jira incremental lookbackMinutes must be a non-negative integer");
  }
  return minutes;
}

function applyLookback(window, lookbackMinutes) {
  if (!window || lookbackMinutes === 0) return window;
  return {
    since: new Date(window.since.getTime() - lookbackMinutes * 60 * 1000),
    until: window.until,
  };
}

/** ADF or string description → plain text-ish */
function extractPlainText(description) {
  if (!description) return null;
  if (typeof description === "string") return description;
  if (description.type === "doc" && Array.isArray(description.content)) {
    const parts = [];
    const walk = (nodes) => {
      for (const node of nodes || []) {
        if (node.type === "text" && node.text) parts.push(node.text);
        if (node.content) walk(node.content);
      }
    };
    walk(description.content);
    return parts.join(" ") || null;
  }
  return null;
}
