import { createHash } from "node:crypto";
import { DataConnector } from "../base/DataConnector.js";
import { JiraClient } from "./JiraClient.js";

const OBJECTS = ["projects", "issues", "users", "statuses", "issueTypes"];

/**
 * Jira Cloud connector.
 * Auth: email + API token (Basic).
 */
export class JiraConnector extends DataConnector {
  /**
   * @param {{
   *   client: JiraClient,
   *   jql?: string,
   *   maxIssues?: number,
   * }} config
   */
  constructor(config) {
    super();
    this.client = config.client;
    this.jql = config.jql || "ORDER BY updated DESC";
    this.maxIssues = config.maxIssues ?? 500;
  }

  static fromEnv() {
    return new JiraConnector({
      client: JiraClient.fromEnv(),
      jql: process.env.JIRA_JQL || "updated >= -365d ORDER BY updated DESC",
      maxIssues: process.env.JIRA_MAX_ISSUES
        ? Number(process.env.JIRA_MAX_ISSUES)
        : 500,
    });
  }

  getConnectorKey() {
    return "jira";
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
      throw new Error(`Unknown Jira object: ${object}`);
    }

    switch (object) {
      case "projects":
        yield* this.extractProjects();
        break;
      case "issues":
        yield* this.extractIssues();
        break;
      case "users":
        yield* this.extractUsers();
        break;
      case "statuses":
        yield* this.extractStatuses();
        break;
      case "issueTypes":
        yield* this.extractIssueTypes();
        break;
      default:
        throw new Error(`Extract not implemented for ${object}`);
    }
  }

  async *extractProjects() {
    for await (const project of this.client.paginate(
      "/rest/api/3/project/search",
      "values",
      {},
      50
    )) {
      yield this.record("projects", project.id || project.key, {
        id: project.id || null,
        key: project.key || null,
        name: project.name || null,
        projectTypeKey: project.projectTypeKey || null,
        style: project.style || null,
        isPrivate: Boolean(project.isPrivate),
        leadAccountId: project.lead?.accountId || null,
        leadDisplayName: project.lead?.displayName || null,
      }, project);
    }
  }

  async *extractIssues() {
    let count = 0;
    for await (const issue of this.client.searchIssues(this.jql)) {
      const fields = issue.fields || {};
      yield this.record("issues", issue.id || issue.key, {
        id: issue.id || null,
        key: issue.key || null,
        summary: fields.summary || null,
        status: fields.status?.name || null,
        statusCategory: fields.status?.statusCategory?.name || null,
        issueType: fields.issuetype?.name || null,
        projectKey: fields.project?.key || null,
        projectName: fields.project?.name || null,
        priority: fields.priority?.name || null,
        assigneeAccountId: fields.assignee?.accountId || null,
        assigneeName: fields.assignee?.displayName || null,
        reporterAccountId: fields.reporter?.accountId || null,
        reporterName: fields.reporter?.displayName || null,
        labels: fields.labels || [],
        created: fields.created || null,
        updated: fields.updated || null,
        description: extractPlainText(fields.description),
      }, issue);

      count += 1;
      if (count >= this.maxIssues) break;
    }
  }

  async *extractUsers() {
    // /rest/api/3/users/search returns a bare array (needs Browse users permission)
    let startAt = 0;
    const pageSize = 50;

    while (true) {
      let users = [];
      try {
        const page = await this.client.request("/rest/api/3/users/search", {
          query: { query: ".", startAt, maxResults: pageSize },
        });
        users = Array.isArray(page) ? page : page.values || [];
      } catch (err) {
        console.warn("[jira] users extract skipped:", err.message);
        return;
      }

      for (const user of users) {
        if (user.accountType === "app") continue;
        yield this.record("users", user.accountId, {
          accountId: user.accountId,
          displayName: user.displayName || null,
          emailAddress: user.emailAddress || null,
          active: Boolean(user.active),
          accountType: user.accountType || null,
          timeZone: user.timeZone || null,
        }, user);
      }

      startAt += users.length;
      if (!users.length || users.length < pageSize) break;
    }
  }

  async *extractStatuses() {
    const statuses = await this.client.request("/rest/api/3/status");
    const list = Array.isArray(statuses) ? statuses : [];
    for (const status of list) {
      yield this.record("statuses", status.id, {
        id: status.id,
        name: status.name || null,
        description: status.description || null,
        statusCategory: status.statusCategory?.name || null,
      }, status);
    }
  }

  async *extractIssueTypes() {
    const types = await this.client.request("/rest/api/3/issuetype");
    const list = Array.isArray(types) ? types : [];
    for (const type of list) {
      yield this.record("issueTypes", type.id, {
        id: type.id,
        name: type.name || null,
        description: type.description || null,
        subtask: Boolean(type.subtask),
        hierarchyLevel: type.hierarchyLevel ?? null,
      }, type);
    }
  }

  record(object, sourceId, data, raw) {
    const payload = {
      connectorKey: "jira",
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
