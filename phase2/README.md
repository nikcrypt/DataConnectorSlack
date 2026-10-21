# Phase 2 — Kafka + Postgres + MinIO skeleton

Runnable slice of the design in [`docs/kafka-postgres-architecture.md`](../docs/kafka-postgres-architecture.md).

Root [`docker-compose.yml`](../docker-compose.yml) is unchanged (Phase 1 QA image).

## Services

| Service | Role |
|---|---|
| `postgres` | System of record (`extraction_requests`, runs, objects, artifacts) |
| `kafka` | KRaft broker; topics `extract.commands`, `extract.events`, `extract.dlq` |
| `minio` | Object store for JSONL artifacts |
| `api` | `POST/GET /extractions`, cancel |
| `status-writer` | Consumes events → Postgres |
| `connector-slack` | Sample worker (`CONNECTOR_KEY=slack`, default `WORKER_MODE=stub`) |

## Start

```bash
cd phase2
docker compose up --build
```

API: `http://localhost:8080`  
MinIO console: `http://localhost:9001` (minioadmin / minioadmin)  
Postgres: `localhost:5433` (connector / connector / connector_platform)

## Try a job

```bash
curl -s -X POST http://localhost:8080/extractions \
  -H 'content-type: application/json' \
  -d '{"connector_key":"slack","objects":["messages","users"],"mode":"full","requested_by":"demo"}'

# use request_id from the response
curl -s http://localhost:8080/extractions/<request_id>
```

Stub workers write sample JSONL to MinIO under `s3://extracts/<tenant>/<connector>/<request_id>/`.

Set `WORKER_MODE=live` on `connector-slack` and provide Slack env (same as Phase 1) to run the real connector through `ConnectorRuntimeEngine`.

## Layout

```text
phase2/
  docker-compose.yml
  Dockerfile
  migrations/001_extraction_platform.sql
  schemas/extract.commands.schema.json
  schemas/extract.events.schema.json
  src/api/server.js
  src/status-writer/index.js
  src/worker/index.js
  src/shared/
```

Add another connector by copying the `connector-slack` service and changing `CONNECTOR_KEY` (and wiring a live factory case when ready).
