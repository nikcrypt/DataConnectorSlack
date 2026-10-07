import "dotenv/config";
import { SampleSlackConnector } from "./SampleSlackConnector.js";
import { MongoRuntime } from "../runtime/MongoRuntime.js";

/**
 * Loads 1000 sample Slack messages into MongoDB, 200 per page.
 * Does not call Slack. Use this to show pagination in Compass.
 *
 *   npm run bench:slack:mongo
 */

const MESSAGES = 1000;
const PAGE_SIZE = 200;

function numberArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return 0;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : 0;
}

async function main() {
  const stopAfter = numberArg("--stop-after");
  const connector = new SampleSlackConnector({
    messages: MESSAGES,
    channels: 10,
    users: 50,
    pageSize: PAGE_SIZE,
    logPages: true,
    connectorKey: "slack",
    stopAfter,
  });
  const runtime = new MongoRuntime(connector);

  console.log(
    `Sample Slack pagination demo: ${MESSAGES} messages, ${PAGE_SIZE} per page, no Slack API call`
  );
  const summary = await runtime.run({ objects: ["messages"], mode: "full" });
  const counts = summary.objects.messages;

  console.log("");
  console.log(`Database: ${summary.database}`);
  console.log(`Collection: ${summary.collection}`);
  console.log(
    `Inserted ${counts.upserted}, updated ${counts.modified}, extracted ${counts.extracted}`
  );
  console.log("Each document has data.page 1 through 5 and data.sample true.");
  console.log("");
  console.log("In mongosh or Compass, group by page:");
  console.log(`use ${summary.database}`);
  console.log(
    `db.${summary.collection}.aggregate([{ $match: { object: "messages", "data.sample": true } }, { $group: { _id: "$data.page", count: { $sum: 1 } } }, { $sort: { _id: 1 } }])`
  );
}

main().catch((err) => {
  console.error("Sample Slack Mongo demo failed:", err.message);
  process.exitCode = 1;
});
