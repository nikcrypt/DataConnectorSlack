/**
 * Proxy extraction jobs to the Phase 2 API (Kafka + Postgres platform).
 * Settings never talks to Kafka directly.
 */

export function phase2BaseUrl() {
  return (process.env.PHASE2_API_URL || "http://localhost:8080").replace(/\/$/, "");
}

export async function createExtraction({
  connectorKey,
  objects,
  mode,
  requestedBy,
  params,
}) {
  const url = `${phase2BaseUrl()}/extractions`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connector_key: connectorKey,
        objects: objects || [],
        mode: mode === "incremental" ? "incremental" : "full",
        requested_by: requestedBy || null,
        params: params || {},
      }),
    });
  } catch (error) {
    throw Object.assign(
      new Error(
        `Phase 2 API unreachable at ${url}. Start it with: cd phase2 && docker compose up --build`
      ),
      { status: 503, cause: error }
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(
      new Error(data.error || `Phase 2 API returned HTTP ${response.status}`),
      { status: response.status >= 400 && response.status < 600 ? response.status : 502 }
    );
  }
  return data;
}

export async function getExtraction(requestId) {
  const url = `${phase2BaseUrl()}/extractions/${encodeURIComponent(requestId)}`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw Object.assign(
      new Error(`Phase 2 API unreachable at ${phase2BaseUrl()}`),
      { status: 503, cause: error }
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(
      new Error(data.error || `Phase 2 API returned HTTP ${response.status}`),
      { status: response.status }
    );
  }
  return data;
}
