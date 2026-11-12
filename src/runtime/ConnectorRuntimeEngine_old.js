import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import loggerFactory from "../logger.js";

const logger = loggerFactory.component("ConnectorRuntimeEngine");
import { prepareRecord } from "./prepareRecord.js";
import {
  checkpointAfterSuccess,
  hasUsableCheckpoint,
  requiresCheckpoint,
} from "./checkpoint.js";

/**
 * Minimal runtime: extract pages from a connector and write JSONL output.
 * Later this can swap to MongoDB upsert + hash change detection.
 */
export class ConnectorRuntimeEngine {
  /**
   * @param {import('../connectors/base/DataConnector.js').DataConnector} connector
   * @param {{ outputDir?: string }} [options]
   */
  constructor(connector, options = {}) {
    this.connector = connector;
    this.outputDir = options.outputDir || path.resolve("data/output");
    this.quiet = Boolean(options.quiet);
  }

  async run({ objects, mode = "full", checkpoint, startedAt } = {}) {
    const selected = objects?.length ? objects : this.connector.getObjects();
    const connectorKey = this.connector.getConnectorKey?.() || "unknown";
    const runStartedAt = new Date(startedAt || Date.now());
    const startedAtIso = runStartedAt.toISOString();
    const summary = {
      connector: connectorKey,
      mode,
      startedAt: startedAtIso,
      objects: {},
    };

    const connectorOutputDir = path.join(this.outputDir, connectorKey);
    const checkpointDir = path.join(this.outputDir, ".checkpoints", connectorKey);
    await mkdir(connectorOutputDir, { recursive: true });
    await mkdir(checkpointDir, { recursive: true });

    const objectCheckpoints = mode === "incremental"
      ? checkpoint
        ? { ...checkpoint }
        : await this.loadCheckpoints(checkpointDir, selected)
      : {};
    if (mode === "incremental") {
      for (const object of selected) {
        if (
          requiresCheckpoint(this.connector, object)
          && !hasUsableCheckpoint(this.connector, object, objectCheckpoints[object])
        ) {
          throw new Error(
            `Incremental extraction requires a previous successful run checkpoint for ${object}.`
          );
        }
      }
    }

    const checkpoints = {};
    const successfulAtByObject = {};
    for (const object of selected) {
      const counts = { extracted: 0 };
      const scope = checkpointScope(this.connector, object);
      if (scope) counts.scope = scope;
      const outPath = path.join(
        connectorOutputDir,
        scopedFileName(object, scope, ".jsonl"),
      );
      const objectCheckpoint = mode === "incremental"
        ? objectCheckpoints[object]
        : null;

      if (!this.quiet) logger.info(`[ConnectorRuntimeEngine] [${this.connector.getConnectorKey?.() || "unknown"} connector] extracting ${object}...`);

      if (connectorKey === "windows") {
        const windowsResult = await this.runWindowsObject({
          object,
          mode,
          outputPath: outPath,
          checkpointDir,
          checkpoint: objectCheckpoint,
          startedAt: startedAtIso,
          onProgress: (count) => {
            if (!this.quiet && count % 100 === 0) {
              logger.info(`[ConnectorRuntimeEngine] [${this.connector.getConnectorKey?.() || "unknown"} connector] ${object}: ${count} records`);
            }
          },
        });
        counts.extracted = windowsResult.count;
        successfulAtByObject[object] = windowsResult.startedAt;
      } else {
        const lines = [];
        try {
          for await (const record of this.connector.extract(object, {
            mode,
            checkpoint: objectCheckpoint,
            startedAt: startedAtIso,
          })) {
            const prepared = prepareRecord(record, this.connector);
            lines.push(JSON.stringify(prepared));
            counts.extracted += 1;
            if (!this.quiet && counts.extracted % 100 === 0) {
              logger.info(`[ConnectorRuntimeEngine] [${this.connector.getConnectorKey?.() || "unknown"} connector] ${object}: ${counts.extracted} records`);
            }
          }
        } catch (error) {
          logger.trackError(error, {
            connector: connectorKey,
            object,
            mode,
            extractedRecords: counts.extracted,
          });

          throw error;
        }

        await writeFile(outPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
      }
      summary.objects[object] = { ...counts, file: outPath };
      if (!this.quiet) {
        logger.info(`[ConnectorRuntimeEngine] [${this.connector.getConnectorKey?.() || "unknown"} connector] ${object}: done (${counts.extracted}) -> ${outPath}`);
      }
    }

    if (mode === "incremental" || mode === "full") {
      for (const object of selected) {
        const nextCheckpoint = checkpointAfterSuccess(
          this.connector,
          object,
          successfulAtByObject[object] || startedAtIso,
        );
        if (!nextCheckpoint) continue;
        checkpoints[object] = nextCheckpoint;
        const scope = checkpointScope(this.connector, object);
        await writeFile(
          path.join(checkpointDir, scopedFileName(object, scope, ".json")),
          JSON.stringify(checkpoints[object], null, 2),
          "utf8"
        );
      }
    }

    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(connectorOutputDir, "run-summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    if (!this.quiet) logger.info(`[ConnectorRuntimeEngine] [${this.connector.getConnectorKey?.() || "unknown"} connector] summary -> ${summaryPath}`);
    return summary;
  }

  async runWindowsObject({ object, mode, outputPath, checkpointDir, checkpoint, startedAt, onProgress }) {
    const tempPath = `${outputPath}.inprogress`;
    const scanStatePath = path.join(checkpointDir, `${object}.scan.json`);
    const stateTempPath = `${scanStatePath}.tmp`;
    const batchSize = boundedEnvInteger("WINDOWS_CHECKPOINT_BATCH_SIZE", 1000, 1, 10000);
    let state = await readJsonOrNull(scanStatePath);
    let resume = Boolean(
      state?.version === 1 &&
      state.mode === mode &&
      typeof state.startedAt === "string" &&
      typeof state.offset === "number" && Number.isSafeInteger(state.offset) && state.offset >= 0 &&
      typeof state.count === "number" && Number.isSafeInteger(state.count) && state.count >= 0 &&
      typeof state.lastSourceId === "string"
    );

    if (resume) {
      try {
        const temp = await open(tempPath, "r+");
        const stat = await temp.stat();
        if (stat.size < state.offset) {
          resume = false;
        } else {
          await temp.truncate(state.offset);
        }
        await temp.close();
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger.error("Error while reading resume file", {
            code: err.code,
            message: err.message,
            stack: err.stack,
          });
          throw err;
        }
        resume = false;
      }
    }

    if (!resume) {
      state = {
        version: 1,
        mode,
        startedAt: startedAt || new Date().toISOString(),
        offset: 0,
        count: 0,
        lastSourceId: "",
        checkpoint,
      };
      await rm(tempPath, { force: true });
      await rm(scanStatePath, { force: true });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = await open(tempPath, "a+");
      try {
        for await (const record of this.connector.extract(object, {
          mode,
          checkpoint: state.checkpoint,
          startedAt: state.startedAt,
          resumeAfter: resume ? state.lastSourceId : null,
        })) {
          const line = `${JSON.stringify(record)}\n`;
          const byteLength = Buffer.byteLength(line, "utf8");
          await handle.writeFile(line, "utf8");
          state.offset += byteLength;
          state.count += 1;
          state.lastSourceId = record.sourceId;
          onProgress(state.count);
          if (state.count % batchSize === 0) {
            await handle.sync();
            await writeFile(stateTempPath, JSON.stringify(state), "utf8");
            await rename(stateTempPath, scanStatePath);
          }
        }

        await handle.sync();
        await handle.close();
        await rename(tempPath, outputPath);
        await rm(scanStatePath, { force: true });
        await rm(stateTempPath, { force: true });
        return { count: state.count, startedAt: state.startedAt };
      } catch (err) {
        await handle.close().catch(() => { });
        if (err.code !== "WINDOWS_RESUME_CURSOR_NOT_FOUND" || attempt > 0) {
          logger.error("Resume cursor processing failed", {
            code: err.code,
            message: err.message,
            stack: err.stack,
            attempt,
          });
          throw err;
        }
        logger.warn("Resume cursor not found. Restarting object extraction from the beginning.");
        // Source ordering changed or the saved cursor disappeared. Restart the
        // object safely rather than append a partial or duplicate result set.
        resume = false;
        state = {
          version: 1,
          mode,
          startedAt: state.startedAt,
          offset: 0,
          count: 0,
          lastSourceId: "",
          checkpoint: state.checkpoint,
        };
        await rm(tempPath, { force: true });
        await rm(scanStatePath, { force: true });
      }
    }
    throw new Error("Unable to resume Windows filesystem extraction");
  }

  async loadCheckpoint(checkpointDir, object) {
    try {
      const scope = checkpointScope(this.connector, object);
      const fileName = scopedFileName(object, scope, ".json");
      return JSON.parse(await readFile(path.join(checkpointDir, fileName), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        logger.warn("File not found.");
        return null;
      }
      logger.error("Failed to read file", {
        code: err.code,
        message: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  async loadCheckpoints(checkpointDir, objects) {
    const checkpoints = {};
    for (const object of objects) {
      checkpoints[object] = await this.loadCheckpoint(checkpointDir, object);
    }
    return checkpoints;
  }
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) {
      logger.warn("State file missing or invalid. Starting fresh.", {
        code: err.code,
        message: err.message,
      });
      return null;
    }
    logger.error("Failed to load state file", {
      code: err.code,
      message: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

function boundedEnvInteger(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function checkpointScope(connector, object) {
  if (typeof connector.getCheckpointScope !== "function") return null;
  const scope = connector.getCheckpointScope(object);
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

function scopedFileName(object, scope, extension) {
  const suffix = scope ? `-${encodeURIComponent(scope)}` : "";
  return `${object}${suffix}${extension}`;
}
