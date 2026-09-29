import { stat } from "node:fs/promises";
import path from "node:path";
import { SampleSlackConnector } from "./SampleSlackConnector.js";
import { ConnectorRuntimeEngine } from "../runtime/ConnectorRuntimeEngine.js";

/**
 * Slack sample-data benchmark.
 *
 * Measures the local connector runtime (normalise, hash, JSONL write).
 * It does not call Slack. Use --delay-ms to imitate per-page API wait.
 *
 *   npm run bench:slack
 *   npm run bench:slack -- --messages 50000 --concurrency 1,4 --delay-ms 0
 */

function parseArgs(argv) {
  const args = {
    users: 500,
    channels: 100,
    messages: 20_000,
    concurrency: [1, 4],
    delayMs: 0,
    pageSize: 200,
    objects: ["messages"],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--users" && value) args.users = Number(value);
    else if (key === "--channels" && value) args.channels = Number(value);
    else if (key === "--messages" && value) args.messages = Number(value);
    else if (key === "--concurrency" && value) {
      args.concurrency = value.split(",").map((n) => Number(n.trim())).filter((n) => n > 0);
    } else if (key === "--delay-ms" && value) args.delayMs = Number(value);
    else if (key === "--page-size" && value) args.pageSize = Number(value);
    else if (key === "--objects" && value) {
      args.objects = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else continue;
    i += 1;
  }

  return args;
}

async function runScenario(args, workers) {
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const outputRoot = path.resolve("data/bench/slack-sample");

  const jobs = [];
  for (let shardIndex = 0; shardIndex < workers; shardIndex += 1) {
    const connector = new SampleSlackConnector({
      users: args.users,
      channels: args.channels,
      messages: args.messages,
      shardIndex,
      shardCount: workers,
      pageSize: args.pageSize,
      delayMs: args.delayMs,
    });
    const runtime = new ConnectorRuntimeEngine(connector, {
      outputDir: path.join(outputRoot, `workers-${workers}`, `shard-${shardIndex}`),
      quiet: true,
    });
    jobs.push(runtime.run({ objects: args.objects, mode: "full" }));
  }

  const summaries = await Promise.all(jobs);
  const elapsedMs = performance.now() - started;
  const rssAfter = process.memoryUsage().rss;

  let records = 0;
  let bytes = 0;
  for (const summary of summaries) {
    for (const object of Object.values(summary.objects)) {
      records += object.extracted;
      const fileStat = await stat(object.file);
      bytes += fileStat.size;
    }
  }

  return {
    workers,
    records,
    elapsedMs: Math.round(elapsedMs),
    recordsPerSec: Math.round(records / (elapsedMs / 1000)),
    outputMb: Number((bytes / (1024 * 1024)).toFixed(2)),
    rssMb: Number((rssAfter / (1024 * 1024)).toFixed(1)),
    rssDeltaMb: Number(((rssAfter - rssBefore) / (1024 * 1024)).toFixed(1)),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const profiles = [
    {
      name: "pipeline",
      note: "No artificial delay. Shows how fast the runtime can hash and write JSONL.",
      delayMs: args.delayMs,
      messages: args.messages,
      concurrency: args.concurrency,
    },
    {
      name: "api-wait",
      note: "50ms pause every 200 messages, imitating one Slack history page. Still faster than Slack's real per-workspace rate limit.",
      delayMs: 50,
      messages: Math.min(args.messages, 4000),
      concurrency: args.concurrency,
    },
  ];

  const report = {
    connector: "slack-sample",
    measuredAt: new Date().toISOString(),
    measured: "Local runtime only (normalise, hash, JSONL). Does not call Slack.",
    dataset: {
      users: args.users,
      channels: args.channels,
      pageSize: args.pageSize,
      objects: args.objects,
    },
    profiles: [],
  };

  console.log("Slack sample benchmark");

  for (const profile of profiles) {
    console.log(`\n${profile.name}: ${profile.note}`);
    const scenarios = [];
    for (const workers of profile.concurrency) {
      const result = await runScenario(
        { ...args, messages: profile.messages, delayMs: profile.delayMs },
        workers
      );
      scenarios.push(result);
      console.log(
        `workers=${result.workers} records=${result.records} elapsedMs=${result.elapsedMs} records/sec=${result.recordsPerSec} outputMb=${result.outputMb} rssMb=${result.rssMb}`
      );
    }
    report.profiles.push({
      name: profile.name,
      note: profile.note,
      messages: profile.messages,
      delayMs: profile.delayMs,
      scenarios,
    });
  }

  const { writeFile, mkdir } = await import("node:fs/promises");
  const outDir = path.resolve("data/bench");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "slack-bench-report.json");
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\nreport -> ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err.message);
  process.exitCode = 1;
});
