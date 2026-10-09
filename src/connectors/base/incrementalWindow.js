/**
 * Time window for an incremental run.
 * since is the previous successful run start. until is this run's start.
 * @param {{ mode?: string, startedAt?: string, checkpoint?: { lastSuccessfulAt?: string, since?: string, until?: string } }} [options]
 * @returns {{ since: Date, until: Date } | null}
 */
export function incrementalWindow(options) {
  if (options?.mode !== "incremental") return null;
  const sinceRaw = options.checkpoint?.lastSuccessfulAt || options.checkpoint?.since;
  if (!sinceRaw) return null;
  const since = new Date(sinceRaw);
  if (Number.isNaN(since.getTime())) return null;
  const untilRaw = options.checkpoint?.until || options.startedAt;
  const until = untilRaw ? new Date(untilRaw) : new Date();
  if (Number.isNaN(until.getTime())) return { since, until: new Date() };
  return { since, until };
}

/** True when value falls in [since, until). A full run has no window and keeps every record. */
export function inWindow(value, window) {
  if (!window) return true;
  if (value == null || value === "") return false;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  if (time < window.since.getTime()) return false;
  if (time >= window.until.getTime()) return false;
  return true;
}
