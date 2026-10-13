const TABLE_API_PATH = "/api/now/table";

export class ServiceNowClient {
  constructor(config) {
    if (!config.baseUrl) {
      throw new Error("Missing ServiceNow config. Set SERVICENOW_BASE_URL.");
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authHeader = createAuthHeader(config);
    this.pageSize = readNumber(config.pageSize, 500);
    this.timeoutMs = readNumber(config.timeoutMs, 30000);
    this.maxRetries = readNumber(config.maxRetries, 4, true);
    this.displayValues = config.displayValues ?? false;
    this.excludeReferenceLinks = config.excludeReferenceLinks ?? true;
  }

  static fromEnv(options = {}) {
    return new ServiceNowClient({
      baseUrl: process.env.SERVICENOW_BASE_URL,
      authType: process.env.SERVICENOW_AUTH_TYPE || "basic",
      username: process.env.SERVICENOW_USERNAME,
      password: process.env.SERVICENOW_PASSWORD,
      accessToken: process.env.SERVICENOW_ACCESS_TOKEN,
      pageSize: process.env.SERVICENOW_PAGE_SIZE ?? options.pageSize,
      timeoutMs:
        process.env.SERVICENOW_REQUEST_TIMEOUT_MS ?? options.requestTimeoutMs,
      maxRetries: process.env.SERVICENOW_MAX_RETRIES ?? options.maxRetries,
      displayValues: options.displayValues,
      excludeReferenceLinks: options.excludeReferenceLinks,
    });
  }

  async testConnection() {
    await this.request(
      `${TABLE_API_PATH}/incident`,
      {
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
      "connection test",
    );

    return {
      ok: true,
      baseUrl: this.baseUrl,
      table: "incident",
    };
  }

  async request(path, query = {}, requestName = "request") {
    const url = new URL(path, `${this.baseUrl}/`);

    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(name, String(value));
      }
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: this.authHeader,
          },
          signal: controller.signal,
        });

        if (isRetryable(response.status) && attempt < this.maxRetries) {
          const delayMs = getRetryDelay(response, attempt);
          console.warn(
            `[servicenow] ${requestName} returned ${describeResponse(response)}. ` +
            `Retry ${attempt + 1} of ${this.maxRetries} in ${formatDelay(delayMs)}.`,
          );
          await response.body?.cancel();
          await sleep(delayMs);
          continue;
        }

        const responseText = await response.text();

        if (response.ok) return parseJson(responseText);

        const details = readErrorDetails(responseText);
        const attemptCount = attempt + 1;
        const suffix = details
          ? ` ${details}`
          : " ServiceNow did not provide error details.";
        throw new Error(
          `ServiceNow ${requestName} failed after ${attemptCount} ${attemptCount === 1 ? "attempt" : "attempts"}: ` +
          `${describeResponse(response)}.${suffix}`,
        );
      } catch (error) {
        if (attempt < this.maxRetries && isNetworkError(error)) {
          const delayMs = 500 * 2 ** attempt;
          console.warn(
            `[servicenow] ${requestName} ${describeNetworkError(error, this.timeoutMs)}. ` +
            `Retry ${attempt + 1} of ${this.maxRetries} in ${formatDelay(delayMs)}.`,
          );
          await sleep(delayMs);
          continue;
        }

        if (error.name === "AbortError") {
          throw new Error(
            `ServiceNow ${requestName} failed after ${attempt + 1} attempts: ` +
            `request timed out after ${this.timeoutMs} ms.`,
          );
        }
        if (error instanceof TypeError) {
          throw new Error(
            `ServiceNow ${requestName} failed after ${attempt + 1} attempts: network request failed.`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("ServiceNow request failed");
  }

  async *paginateTable(table, { fields, query = "" } = {}) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      throw new Error(`Invalid ServiceNow table name: ${table}`);
    }

    let lastSysId = null;
    let pageNumber = 1;

    while (true) {
      const pageQuery = [
        query,
        lastSysId ? `sys_id>${lastSysId}` : "",
        "ORDERBYsys_id",
      ].filter(Boolean).join("^");

      const requestedFields = fields?.length
        ? [...new Set([...fields, "sys_id"])].join(",")
        : undefined;

      const data = await this.request(
        `${TABLE_API_PATH}/${table}`,
        {
          sysparm_limit: this.pageSize,
          sysparm_query: pageQuery,
          sysparm_fields: requestedFields,
          sysparm_display_value: this.displayValues,
          sysparm_exclude_reference_link: this.excludeReferenceLinks,
        },
        `${table} page ${pageNumber}`,
      );

      if (!Array.isArray(data.result)) {
        throw new Error(`ServiceNow ${table} response does not contain a result array`);
      }

      for (const record of data.result) {
        yield record;
      }

      if (data.result.length < this.pageSize) return;

      const nextSysId = readValue(data.result.at(-1)?.sys_id);
      if (!nextSysId || nextSysId === lastSysId) {
        throw new Error(`ServiceNow ${table} pagination did not advance`);
      }
      lastSysId = nextSysId;
      pageNumber += 1;
    }
  }
}

function createAuthHeader(config) {
  const authType = String(config.authType || "basic").toLowerCase();

  if (authType === "bearer" || authType === "oauth") {
    if (!config.accessToken) {
      throw new Error("SERVICENOW_ACCESS_TOKEN is required for bearer authentication");
    }
    return `Bearer ${config.accessToken}`;
  }

  if (authType !== "basic") {
    throw new Error(`Unsupported ServiceNow authentication type: ${authType}`);
  }
  if (!config.username || !config.password) {
    throw new Error(
      "SERVICENOW_USERNAME and SERVICENOW_PASSWORD are required for basic authentication"
    );
  }

  const credentials = Buffer.from(
    `${config.username}:${config.password}`
  ).toString("base64");
  return `Basic ${credentials}`;
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("ServiceNow returned an invalid JSON response");
  }
}

function parseJsonIfValid(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readErrorDetails(text) {
  const data = parseJsonIfValid(text);
  const serviceNowMessage = data?.error?.detail || data?.error?.message;
  const message = serviceNowMessage || text;
  if (!message) return "";

  const plainText = String(message)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!plainText) return "";
  return plainText.length > 200 ? `${plainText.slice(0, 197)}...` : plainText;
}

function readValue(value) {
  if (value && typeof value === "object") return value.value || "";
  return value == null ? "" : String(value);
}

function isRetryable(status) {
  return status === 429 || status >= 500;
}

function isNetworkError(error) {
  return error.name === "AbortError" || error instanceof TypeError;
}

function getRetryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }

  return 500 * 2 ** attempt;
}

function describeResponse(response) {
  const statusText = response.statusText?.trim();
  return `HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`;
}

function describeNetworkError(error, timeoutMs) {
  return error.name === "AbortError"
    ? `timed out after ${timeoutMs} ms`
    : "could not reach ServiceNow";
}

function formatDelay(delayMs) {
  if (delayMs < 1000) return `${delayMs} ms`;
  const seconds = delayMs / 1000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function readNumber(value, fallback, allowZero = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`Expected an integer greater than or equal to ${minimum}`);
  }
  return number;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export { readValue };
