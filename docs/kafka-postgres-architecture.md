# Phase 2 Design: Scalable Connector Platform

**Status:** Proposed  
**Audience:** Engineering + stakeholders  
**Related POC:** `data-connector-app-poc` (Slack, Postgres, SharePoint, Salesforce, Jira, Google Drive, Box)  
**Supersedes (for Phase 2 messaging):** RabbitMQ path in `docs/phase1-vs-rabbitmq-comparison.md`

---

## 1. Summary

Propose a **Phase-2 scalable connector platform** with:

| Piece | Role |
|---|---|
| **One Docker service per connector** | Isolate Slack, Jira, Box, etc.; scale each independently |
| **Kafka** | Async bus for extraction **commands** and **progress/completion events** |
| **PostgreSQL** | **System of record** for user-triggered jobs (status, audit, UI queries) |
| **Object store (MinIO/S3)** | Store extract artifacts (JSONL/Parquet); Postgres keeps URIs + counts |

**Bottom line:** Kafka moves work; Postgres remembers what users asked for. Neither replaces the other. RabbitMQ is **not** required if Kafka is chosen.

---

## 2. Why Phase 2 (vs current POC)

| Today (Phase 1) | Phase 2 |
|---|---|
| `npm run extract:jira` in one process | API creates a job → Kafka → `jira` container |
| Shared `DataConnector` contract + runtime writes local JSONL | Same contract inside each worker; output → object store |
| Fine for demos and connector correctness | Needed when jobs are long, concurrent, multi-tenant, or UI-driven |

Phase 1 stays valuable for proving auth, paging, and normalisation. Phase 2 changes **transport and operations**, not the connector contract.

---

## 3. Problem Kafka solves vs problem Postgres solves

| Concern | Kafka | PostgreSQL |
|---|---|---|
| Queue / fan-out extraction work | Yes | No |
| Backpressure, scale consumers, replay | Yes | No |
| “What did the user request?” / job status UI | Poor fit | Yes |
| Audit, who triggered what, cancel/retry | Poor fit | Yes |
| Idempotency keys, checkpoints (authoritative) | Events only | Yes |

Kafka topics are logs, not a queryable job board. Postgres alone cannot efficiently fan out thousands of long-running extracts across many workers. **Both are required.**

### What Kafka’s job is (plain language)

Kafka is the **conveyor belt**:

1. Carry **extraction commands** (`please run Jira extract for request_id=…`).
2. Decouple the API from slow connector work (API returns `202` immediately).
3. Let you **scale workers** via consumer groups (more replicas → more parallel jobs).
4. Carry **progress / completed / failed** events back so status can be updated.
5. Buffer spikes and support DLQ / replay for ops.

Kafka does **not** store the official job list for the UI.

---

## 4. Target architecture

```text
┌─────────────┐     ┌──────────────┐     ┌─────────────────────────────────────┐
│ End user /  │────▶│  API Gateway │────▶│ PostgreSQL                          │
│ UI          │     │  (create job)│     │ extraction_requests, runs, artifacts│
└─────────────┘     └──────┬───────┘     └──────────────────▲──────────────────┘
                           │ publish command                │ update status
                           ▼                                │
                    ┌──────────────┐                        │
                    │    Kafka     │                        │
                    │ extract.     │                        │
                    │  commands    │                        │
                    │ extract.     │────────────────────────┤
                    │  events      │   status-writer        │
                    └──────┬───────┘                        │
           ┌───────────────┼───────────────┐                │
           ▼               ▼               ▼                │
    ┌────────────┐  ┌────────────┐  ┌────────────┐         │
    │ slack      │  │ jira       │  │ box / …    │─────────┘
    │ worker     │  │ worker     │  │ workers    │  (emit events)
    └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
          │               │               │
          └───────────────┴───────────────┘
                          ▼
                 Object store (MinIO / S3)
                 JSONL / Parquet per object
```

### Docker services

| Service | Responsibility |
|---|---|
| `api` | REST: create extraction, list/get status, cancel |
| `postgres` | System of record |
| `kafka` | Command + event topics (KRaft or ZooKeeper) |
| `connector-<name>` | One container/image per connector; consumes commands, runs extract |
| `status-writer` | Consumes `extract.events` → updates Postgres |
| `minio` (or S3) | Artifact storage |

Optional later: auth/gateway, Vault for secrets, metrics (Prometheus), OpenTelemetry.

---

## 5. Responsibility split (design rules)

1. **API writes Postgres first**, then publishes to Kafka.  
   A `request_id` exists even if Kafka is briefly unavailable. The UI never depends on “message still in the topic.”

2. **Workers are executors.** They load job details (and secret refs) by `request_id`, run the existing `DataConnector` + runtime, write artifacts, emit events.

3. **Status-writer owns job status mutations** driven by Kafka events. Avoids racey dual-writes from many worker replicas.

4. **Secrets never ride in Kafka payloads.** Store refs in Postgres / Vault; workers fetch at runtime.

5. **Shared connector contract stays.** Methods (`testConnection`, `getObjects`, `extract`) and record shape (`connectorKey`, `object`, `sourceId`, `data`, `hash`, `isDeleted`) remain the plug every connector implements.

---

## 6. End-to-end sequence

```text
User                API                 Postgres           Kafka              Worker            StatusWriter    Store
 │                   │                     │                 │                  │                   │            │
 │ POST /extractions  │                     │                 │                  │                   │            │
 │──────────────────▶│ INSERT queued       │                 │                  │                   │            │
 │                   │────────────────────▶│                 │                  │                   │            │
 │                   │ publish command     │                 │                  │                   │            │
 │                   │──────────────────────────────────────▶│                  │                   │            │
 │ 202 + request_id │                     │                 │                  │                   │            │
 │◀──────────────────│                     │                 │                  │                   │            │
 │                   │                     │                 │ consume         │                   │            │
 │                   │                     │                 │─────────────────▶│                   │            │
 │                   │                     │ read job+creds  │                  │                   │            │
 │                   │                     │◀─────────────────│──────────────────│                   │            │
 │                   │                     │                 │◀─ started ───────│                   │            │
 │                   │                     │◀────────────────────────────────────│───────────────────│            │
 │                   │                     │ status=running  │                  │ write JSONL       │            │
 │                   │                     │                 │                  │───────────────────┼───────────▶│
 │                   │                     │                 │◀─ progress ──────│                   │            │
 │                   │                     │◀─ update counts ───────────────────│───────────────────│            │
 │                   │                     │                 │◀─ completed ─────│                   │            │
 │                   │                     │◀─ succeeded + artifact URIs ───────│───────────────────│            │
 │ GET /extractions/id│                     │                 │                  │                   │            │
 │──────────────────▶│ SELECT status+uris  │                 │                  │                   │            │
 │◀──────────────────│                     │                 │                  │                   │            │
```

---

## 7. Kafka topics

| Topic | Producer | Consumer | Purpose |
|---|---|---|---|
| `extract.commands` | API | Connector workers | New extraction jobs |
| `extract.events` | Workers | Status-writer (and later audit/analytics) | `started` / `progress` / `completed` / `failed` |
| `extract.dlq` | Workers / status-writer | Ops / redrive | Poison messages after N failures |

**Partition key:** `connectorKey` or `tenantId:connectorKey` so one connector’s backlog does not starve others, and that worker set can scale independently.

### Example command message

```json
{
  "request_id": "a1b2c3d4",
  "connector_key": "jira",
  "objects": ["projects", "issues"],
  "mode": "full",
  "requested_at": "2026-09-24T16:00:00Z"
}
```

### Example event message

```json
{
  "request_id": "a1b2c3d4",
  "event": "progress",
  "connector_key": "jira",
  "object": "issues",
  "records_written": 120,
  "at": "2026-09-24T16:01:12Z"
}
```

---

## 8. PostgreSQL schema (system of record)

Illustrative tables:

### `extraction_requests`

User-facing job.

| Column | Notes |
|---|---|
| `id` (UUID) | Primary key = `request_id` |
| `tenant_id` | Multi-tenant isolation |
| `connector_key` | `slack`, `jira`, `box`, … |
| `objects` | JSONB array of object names |
| `params` | JSONB (JQL, folder id, history days, …) |
| `requested_by` | User / service identity |
| `status` | `queued` \| `running` \| `succeeded` \| `failed` \| `cancelled` |
| `created_at` / `updated_at` | Timestamps |
| `error_message` | Last failure summary |

### `extraction_runs`

One attempt per request (supports retry).

| Column | Notes |
|---|---|
| `id` | Run id |
| `request_id` | FK |
| `attempt` | 1, 2, … |
| `worker_id` | Container / pod identity |
| `started_at` / `finished_at` | Timing |
| `error` | Failure detail |

### `extraction_objects`

Per-object progress and checkpoint.

| Column | Notes |
|---|---|
| `request_id` + `object` | Composite key |
| `status` | Per-object status |
| `records_written` | Counter |
| `checkpoint` | JSONB (cursor, page token, …) |

### `output_artifacts`

| Column | Notes |
|---|---|
| `request_id` + `object` | Link to extract slice |
| `uri` | `s3://bucket/…/issues.jsonl` |
| `bytes` / `record_count` | Size metadata |
| `content_hash` | Integrity / change detection |

### `connectors`

Registry of enabled connectors, image tags, default concurrency.

---

## 9. Connector workers (Docker)

Each worker:

1. Joins Kafka consumer group for `extract.commands` (filter or route by `connector_key`; or use per-connector topics later).
2. On message: load request from Postgres; resolve credentials; call existing connector `extract()`.
3. Stream records through the same runtime pattern as Phase 1; upload pages to object store.
4. Emit `extract.events`; commit Kafka offset only after durable progress is recorded (at-least-once + idempotent writes).

**Scaling:** increase replicas of `connector-jira`. Same consumer group → Kafka rebalances partitions.

**Isolation:** Slack outage / rate limits do not stop Jira workers (separate deployments).

**Idempotency:** unique `(request_id, object)` / successful run → skip re-processing on redelivery.

---

## 10. Object storage

Phase 1 writes `data/output/<connector>/*.jsonl` on local disk.  
Phase 2 writes the same logical files to **MinIO/S3** and stores URIs in `output_artifacts`.

Postgres does **not** store full extract payloads at scale.

---

## 11. Kafka vs RabbitMQ (for stakeholders)

| | Kafka (proposed) | RabbitMQ (alternative) |
|---|---|---|
| Role | Durable log: commands + events | Classic work queues |
| Postgres still required? | **Yes** | **Yes** |
| Replay after bugfix | Natural | Harder (acked messages gone) |
| Many listeners on progress | Topics / consumer groups | Extra fanout setup |
| Fit | Platform-style multi-connector | Fine for simpler “run this job” |

**Either broker still needs Postgres** as the system of record. Choosing Kafka avoids a second broker and fits command + event streams in one place. RabbitMQ is a valid alternative transport; it does not remove Postgres.

---

## 12. Mapping from current POC

| POC component | Phase 2 home |
|---|---|
| `src/connectors/*/…Connector.js` | Inside `connector-<name>` image |
| `src/connectors/base/DataConnector.js` | Shared library / package |
| `src/runtime/ConnectorRuntimeEngine.js` | Worker runtime (output target → S3) |
| `src/cli.js` / `npm run extract:*` | Kept for local Phase 1; API + Kafka for platform |
| `data/output/…` | Object store artifacts |

---

## 13. Suggested Docker Compose layout (implementation sketch)

```text
docker-compose.yml
  postgres
  kafka
  minio
  api
  status-writer
  connector-slack
  connector-postgres
  connector-sharepoint
  connector-salesforce
  connector-jira
  connector-googledrive
  connector-box
```

Each connector container: same Node base image, different `CONNECTOR_KEY` / entrypoint, env for Kafka brokers, Postgres DSN, object-store credentials.

---

## 14. API surface (minimal)

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/extractions` | Create request → Postgres `queued` → Kafka command → `202` + `request_id` |
| `GET` | `/extractions/{id}` | Status, per-object progress, artifact URIs |
| `GET` | `/extractions` | List/filter by tenant, connector, status |
| `POST` | `/extractions/{id}/cancel` | Mark cancelled; workers check flag / ignore late work |
| `POST` | `/connectors/{key}/test` | Optional: sync or short-lived job for `testConnection()` |

---

## 15. Non-goals (Phase 2a)

- Rewriting every connector in another language
- Replacing the shared record contract
- Using Kafka as the only store for job history
- Downloading full file bytes for Drive/Box/SharePoint (metadata-first remains)

---

## 16. Rollout plan

| Step | Deliverable |
|---|---|
| 1 | This design accepted |
| 2 | Compose: Postgres + Kafka + MinIO + stub API |
| 3 | Schema migrations + message JSON schemas |
| 4 | Kafka consumer loop wrapping **one** existing connector (e.g. Jira) |
| 5 | Status-writer + UI/API status read path |
| 6 | Remaining connectors as additional services (same pattern) |

---

## 17. Decision record

| Decision | Choice | Rationale |
|---|---|---|
| Message broker | **Kafka** | Commands + events, scale, replay; no RabbitMQ needed |
| Job / request tracking | **PostgreSQL** | Queryable system of record for users and ops |
| Connector packaging | **One Docker service per connector** | Isolate failures; scale hot connectors |
| Artifacts | **Object store** | Keep DB lean; retain JSONL/Parquet outputs |
| Connector logic | **Reuse Phase 1 contract** | Transport changes; behaviour stays |

---

## 18. One-line pitch

> **Postgres remembers the extraction request; Kafka delivers it to the right Dockerized connector and streams progress back; object storage holds the data.**
