import "dotenv/config";
import { WindowsConnector } from "./WindowsConnector.js";
import { ConnectorRuntimeEngine } from "../../runtime/ConnectorRuntimeEngine.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  const connector = WindowsConnector.fromEnv();
  if (command === "collect") {
    const mode = optionValue(args, "--mode") || "full";
    if (mode !== "full" && mode !== "incremental") {
      throw new Error("Mode must be full or incremental.");
    }
    const runtime = new ConnectorRuntimeEngine(connector);
    await runtime.run({ objects: ["folders", "files"], mode });
    return;
  }

  if (command === "download") {
    const filename = args.find((arg) => !arg.startsWith("--"));
    const page = optionNumber(args, "--page", 1);
    const pageSize = optionNumber(args, "--page-size", 20);
    if (!filename) throw new Error("Specify the exact filename to download.");
    const result = await connector.downloadByName(filename, { page, pageSize });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown Windows command: ${command}. Use collect or download.`);
}

function optionNumber(args, option, fallback) {
  const index = args.indexOf(option);
  if (index === -1) return fallback;
  return Number(args[index + 1]);
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index === -1 ? null : args[index + 1];
}

function printHelp() {
  console.log(`
Windows filesystem commands

  node src/connectors/windows/WindowsCli.js collect
  node src/connectors/windows/WindowsCli.js collect --mode incremental
  node src/connectors/windows/WindowsCli.js download "filename" --page 1 --page-size 20

Collect writes metadata to data/output/windows/files.jsonl and folders.jsonl.
Exact-name download pages default to 20 matches; page size must be 1–1000.
`);
}

main().catch((err) => {
  console.error(`Windows filesystem error: ${err.message}`);
  process.exitCode = 1;
});
