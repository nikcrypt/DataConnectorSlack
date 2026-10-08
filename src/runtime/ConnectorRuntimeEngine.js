import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

    if (mode === "incremental") {
      const objectCheckpoints = checkpoint
        ? { ...checkpoint }
        : await this.loadCheckpoints(checkpointDir, selected);
      for (const object of selected) {
        const checkpointRequired = this.connector.getCheckpoint?.(object) !== null
          && this.connector.getCheckpoint?.(object) !== undefined;
        if (checkpointRequired && !objectCheckpoints[object]?.lastSuccessfulAt) {
          throw new Error(
            `Incremental extraction requires a previous successful run checkpoint for ${object}.`
          );
        }
      }
    }

    const checkpoints = {};
    for (const object of selected) {
      const counts = { extracted: 0 };
      const outPath = path.join(connectorOutputDir, `${object}.jsonl`);
      const lines = [];
      const objectCheckpoint = mode === "incremental"
        ? checkpoint?.[object] || await this.loadCheckpoint(checkpointDir, object)
        : null;

      if (!this.quiet) console.log(`[runtime] extracting ${object}...`);

      for await (const record of this.connector.extract(object, {
        mode,
        checkpoint: objectCheckpoint,
        startedAt: startedAtIso,
      })) {
        lines.push(JSON.stringify(record));
        counts.extracted += 1;
        if (!this.quiet && counts.extracted % 100 === 0) {
          console.log(`[runtime] ${object}: ${counts.extracted} records`);
        }
      }

      await writeFile(outPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
      summary.objects[object] = { ...counts, file: outPath };
      if (!this.quiet) {
        console.log(`[runtime] ${object}: done (${counts.extracted}) -> ${outPath}`);
      }
    }

    if (mode === "incremental" || mode === "full") {
      for (const object of selected) {
        if (this.connector.getCheckpoint?.(object) === null) continue;
        checkpoints[object] = { lastSuccessfulAt: startedAtIso };
        await writeFile(
          path.join(checkpointDir, `${object}.json`),
          JSON.stringify(checkpoints[object], null, 2),
          "utf8"
        );
      }
    }

    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(connectorOutputDir, "run-summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    if (!this.quiet) console.log(`[runtime] summary -> ${summaryPath}`);
    return summary;
  }

  async loadCheckpoint(checkpointDir, object) {
    try {
      return JSON.parse(await readFile(path.join(checkpointDir, `${object}.json`), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
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
