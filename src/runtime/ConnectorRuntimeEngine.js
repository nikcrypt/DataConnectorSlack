import { mkdir, writeFile } from "node:fs/promises";
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
  }

  async run({ objects, mode = "full" } = {}) {
    const selected = objects?.length ? objects : this.connector.getObjects();
    const startedAt = new Date().toISOString();
    const summary = {
      connector: "slack",
      mode,
      startedAt,
      objects: {},
    };

    await mkdir(this.outputDir, { recursive: true });

    for (const object of selected) {
      const counts = { extracted: 0 };
      const outPath = path.join(this.outputDir, `${object}.jsonl`);
      const lines = [];

      console.log(`[runtime] extracting ${object}...`);

      for await (const record of this.connector.extract(object, { mode })) {
        lines.push(JSON.stringify(record));
        counts.extracted += 1;
        if (counts.extracted % 100 === 0) {
          console.log(`[runtime] ${object}: ${counts.extracted} records`);
        }
      }

      await writeFile(outPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
      summary.objects[object] = { ...counts, file: outPath };
      console.log(`[runtime] ${object}: done (${counts.extracted}) -> ${outPath}`);
    }

    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(this.outputDir, "run-summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`[runtime] summary -> ${summaryPath}`);
    return summary;
  }
}
