# Connector Platform: Architecture Options Comparison

**Purpose:** Compare the simple Phase‑1 approach with a RabbitMQ / microservices approach, and explain why Phase 1 does **not** need a message queue.

**Audience:** Engineering team and stakeholders  
**Related POC:** Slack connector (`cli` → connector → runtime → files)

---

## 1. Summary

| Phase | Approach | Message queue? |
|---|---|---|
| **Phase 1 (now)** | CLI / local runner + shared connector contract + runtime in one (or modular) Node flow | **Not needed** |
| **Phase 2 (later)** | REST API + core engine + connector services + optional RabbitMQ | **Add when jobs are long, concurrent, or must be platform‑grade** |

**Bottom line:** Phase 1 proves *connector behaviour and shared contracts*. RabbitMQ solves *async jobs, buffering, retries, and decoupling* — problems we do not need to solve first.

---

## 1A. What is a “shared contract”?

A **shared contract** is the **common agreement** every connector must follow so the runtime/core can treat Slack, Postgres, Jira, etc. the same way.

Think of it like a **standard plug**:

- The **runtime/core** is the wall socket.
- Each **connector** is a device (Slack, Postgres, …).
- The **contract** is the plug shape. If every connector uses the same plug, the runtime does not need special code for each source.

Without a shared contract, every connector would return different shapes and methods, and the runtime would need custom logic for each one.

### What our shared contract includes

| Part of contract | Meaning | Example |
|---|---|---|
| **Methods** | Functions every connector must implement | `testConnection()`, `getObjects()`, `extract(object)` |
| **Object names** | What can be extracted | `users`, `channels`, `messages` (Slack) or `schemas`, `tables` (Postgres) |
| **Record shape** | Same JSON structure for every source | See below |
| **Identifiers** | How we uniquely identify a row | `connectorKey + object + sourceId` |
| **Behaviour** | How extract works | Page by page; yield/normalise records; don’t dump everything at once |

### Standard record shape (the data contract)

Every connector should produce records like this:

```json
{
  "connectorKey": "slack",
  "object": "messages",
  "sourceId": "C123:171234.001",
  "data": { "text": "hello", "channelId": "C123" },
  "hash": "abc...",
  "isDeleted": false
}
```

| Field | Purpose |
|---|---|
| `connectorKey` | Which source (`slack`, `postgres`, …) |
| `object` | Which entity type (`users`, `messages`, `columns`, …) |
| `sourceId` | Stable unique id in that source |
| `data` | Clean normalised fields for storage/analytics |
| `hash` | Detect unchanged records later |
| `isDeleted` | Soft-delete / tombstone support |

### Why the shared contract matters

1. **One runtime/core** can run any connector without knowing Slack APIs or SQL.
2. **All developers** build to the same interface — easier reviews and onboarding.
3. **Phase 2 stays easy** — HTTP or RabbitMQ only change *transport*; the contract (methods + record shape) stays.
4. **Tech-independent later** — a connector in another language can still speak the same job/record contract.

### Simple analogy

> Shared contract = “every restaurant must accept the same order form.”  
> Kitchen (connector) can cook different food (Slack vs Postgres), but the waiter (runtime/core) always collects the same order slip format.

### In our Slack POC

- `DataConnector.js` defines the method contract.
- `SlackConnector.js` implements it for Slack.
- `ConnectorRuntimeEngine.js` only calls the contract — it never calls Slack directly.

That is the shared contract in action.

---

## 2. Option A — Simple Phase 1 (recommended first)

### Flow

```text
CLI / local runner
        │
        ▼
Runtime Engine
        │  function call (in process)
        ▼
Connector (e.g. Slack)
        │  HTTPS
        ▼
Source system (Slack Web API / Postgres / …)
        │
        ▼
Output (JSONL files or DB)
```

### How parts talk

- **CLI → Runtime:** start job (connector name, objects, mode).
- **Runtime → Connector:** `extract(object)` / async iterator of normalised records.
- **No broker.** Data is passed in memory (`yield` records).

### What this is good for

- Learning and finishing each source connector (auth, paging, scopes, normalisation).
- Agreeing one record contract for all developers.
- Fast feedback (`npm run test:connection`, `npm run extract`).
- Low operational cost (no RabbitMQ, no multi‑service deploy).

### Limits

- Not ideal for many concurrent tenant jobs.
- Long extracts tied to a running process / machine.
- Local files (in the Slack POC) are not a multi‑user product store.
- Does not by itself showcase fully independent connector deployables.

---

## 3. Option B — Direct HTTP between core and connector (middle step)

### Flow

```text
REST API / Core
        │  HTTP POST /extract (start job)
        ▼
Connector microservice (Slack)
        │
        ▼
Source system
        │
        ▼
Core or connector writes DB / returns job status
```

### Notes

- Still **microservices**, but **no RabbitMQ**.
- Core triggers Slack service directly.
- API should return quickly (`202 Accepted` + `jobId`); extract runs in the background on the connector service.
- Good bridge between Phase 1 and full queue‑based design.

### When enough

- Few connectors, moderate job volume.
- Team wants separate services without broker complexity yet.

---

## 4. Option C — Core + RabbitMQ + connector services (Phase 2 target)

### Flow

```text
Client
  │ REST
  ▼
Core engine
  │ publish job
  ▼
RabbitMQ
  │
  ▼
Connector service
  │ publish batches
  ▼
RabbitMQ
  │
  ▼
Core engine → validate / transform / store → Database
```

### What RabbitMQ adds

| Capability | Why it matters |
|---|---|
| Async jobs | Long Slack/DB syncs do not block the API |
| Buffering | Spikes of jobs wait in the queue |
| Retries | Failed jobs/batches can be redelivered |
| Decoupling | Core does not need the connector up at the exact moment of the HTTP call |
| Independent scale | Scale Slack workers without scaling core |
| Failure isolation | One connector crashing does not take down core |
| Platform story | Tech‑independent connectors behind a stable job/batch contract |

### Cost

- More moving parts (broker, consumers, DLQ, monitoring).
- Need stable message schemas, idempotent writes, checkpoints.
- Higher ops burden than Phase 1.

---

## 5. Comparison table

| Concern | Phase 1 simple | Direct HTTP services | Core + RabbitMQ |
|---|---|---|---|
| Speed to build connectors | Highest | Medium | Lower (more wiring) |
| Shared extract contract | Yes | Yes | Yes |
| Start job via product API | No (CLI) | Yes | Yes |
| Long‑running jobs | Weak | Medium (if async on service) | Strong |
| Retry / durability | Manual re‑run | Custom | Built‑in patterns |
| Traffic spikes | Weak | Weak–medium | Strong |
| Scale connectors separately | No | Yes | Yes |
| Ops complexity | Low | Medium | Higher |
| Showcase platform independence | Limited | Good | Strongest |

---

## 6. Why Phase 1 does **not** need RabbitMQ

1. **Different problem.** Phase 1 goal is correct extract + common interface. RabbitMQ does not make Slack auth or paging easier.

2. **We can do it simply.** CLI → runtime → connector → files already proves the full data path for one workspace.

3. **Queue problems are not blocking us yet.** We are not running multi‑tenant production load, background fleets of workers, or bursty job spikes.

4. **Same contract later.**  
   - Phase 1: runtime calls `extract()` in process.  
   - Phase 2: core sends a job message; connector still extracts page by page and returns normalised records.  
   The *connector logic* largely stays; only *transport* changes.

5. **Avoid premature complexity.** Introducing RabbitMQ before connectors are stable slows every developer without proving source integrations faster.

6. **Direct call remains an option.** Even in a service world, core can HTTP‑trigger the Slack service first; add RabbitMQ when reliability/scale requirements appear (or when the demo requires an event‑driven platform).

---

## 7. When we **should** introduce RabbitMQ

Add a message queue when one or more become true:

- Extracts regularly take many minutes and must survive API/client disconnects.
- Multiple jobs must run concurrently for different tenants/connectors.
- We need automatic retries and dead‑letter handling.
- Core and connectors must scale and deploy independently under real load.
- Product requirement is to showcase a message‑driven, tech‑independent connector platform.

Until then, **simple Phase 1 is the right default**.

---

## 8. Recommended phased plan

### Phase 1 — Simple architecture (no RabbitMQ)

- Shared connector contract (`testConnection`, `getObjects`, `extract`, normalised records).
- Runtime + CLI (or thin local runner).
- Each developer delivers one connector (Slack, Postgres, …).
- Output to files or a shared DB for demos.

**Exit criteria:** All target connectors extract successfully on the shared contract.

### Phase 2 — Platform architecture

- One core engine (REST + job orchestration + persist).
- Connector microservices.
- RabbitMQ (or equivalent) for jobs/batches **when** async/reliability/scale (or platform demo) requires it.
- Optional interim: direct HTTP start‑job between core and connectors before the broker.

---

## 9. One‑paragraph stakeholder statement

> In Phase 1 we deliberately avoid RabbitMQ. A simple CLI/runtime/connector flow is enough to build and validate all Node connectors with one shared contract. Message queues become valuable in Phase 2 for long‑running jobs, retries, buffering, and decoupling core from connector services. Using a queue earlier would add operational cost without speeding up connector delivery. We can integrate RabbitMQ once Phase 1 connectors are complete and we move to the production / platform showcase architecture.

---

## 10. Related mental model (POC today)

```text
npm run extract (cli.js)
        → SlackConnector (extract + normalise)
        → SlackClient (HTTP + paging + tokens)
        → Slack Web API
        → ConnectorRuntimeEngine (save)
        → data/output/*.jsonl
```

This is Option A in practice for Slack. Phase 2 reuses the connector ideas; it changes how the core and connectors communicate (HTTP and/or RabbitMQ) and where results are stored (database).
