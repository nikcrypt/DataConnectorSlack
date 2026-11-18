export async function getDashboardSummary(database, endDate = new Date()) {
  const rangeDays = 7;
  const startDate = new Date(endDate.getTime() - rangeDays * 24 * 60 * 60 * 1000);

  const extractions = { total: 0, succeeded: 0, failed: 0, running: 0 };
  let recordsExtracted = 0;
  let lastFailedAt = null;

  const runs = database.collection("extraction_runs").find(
    { startedAt: { $gte: startDate, $lt: endDate } },
    {
      projection: { _id: 0, status: 1, finishedAt: 1, objects: 1 },
    },
  );
  try {
    for await (const run of runs) {
      extractions.total++;
      if (run.status === "succeeded") extractions.succeeded++;
      if (run.status === "failed") extractions.failed++;
      if (run.status === "running") extractions.running++;

      for (const objectResult of Object.values(run.objects || {})) {
        const recordCount = objectResult.extracted;
        if (Number.isFinite(recordCount) && recordCount >= 0) {
          recordsExtracted += recordCount;
        }
      }

      if (run.status === "failed" && run.finishedAt) {
        if (!lastFailedAt || run.finishedAt > lastFailedAt) {
          lastFailedAt = run.finishedAt;
        }
      }
    }
  } finally {
    await runs.close();
  }

  return {
    range: `${rangeDays}d`,
    connections: 1,
    extractions,
    recordsExtracted,
    lastFailedAt: lastFailedAt ? lastFailedAt.toISOString() : null,
  };
}
