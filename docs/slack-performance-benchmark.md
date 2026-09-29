# Connector performance and Slack sample benchmark

**Audience:** Engineering demo  
**What this measures:** The local connector runtime (normalise, hash, write JSONL).  
**What this does not measure:** Slack, Jira, Oracle, or any other live API.

---

## 1. Two different limits

Every connector has two ceilings. They are not the same number.

| Limit | Who sets it | What happens if you add more workers |
|---|---|---|
| **Source API** | Slack / Jira / Oracle / Drive rate limits and page size | Usually **no gain** for one tenant. Extra workers share the same quota and start getting `429`. |
| **Local runtime** | Node process: hash, JSON serialise, disk write | More workers help until CPU or disk saturates. |

For a team showcase, the useful sentence is:

> The connector code can move well over 100,000 records/second on this machine. A real Slack workspace cannot. Plan capacity from the **API tier**, not from the local benchmark.

### Slack planning number (not a measured Slack run)

Slack groups methods into tiers. `conversations.history` is a **Tier 3** method: on the order of **50+ requests per minute** per workspace. A history page is often 100–200 messages (the API allows up to about 1,000).

A conservative planning budget:

```text
50 requests/minute × 200 messages/page ≈ 10,000 messages/minute
≈ 170 messages/second sustained for one Slack workspace
```

That is the number to quote for Slack concurrency. More Docker replicas against the **same** bot token do not multiply it.

Other connectors follow the same shape, with different quotas:

| Connector | Typical bottleneck |
|---|---|
| Slack | Method tier, per workspace |
| Jira / Confluence | Per-site REST limits and search cost |
| Salesforce | Daily API calls and query row limits |
| Google Drive / Box | Per-user or per-app query quotas |
| Postgres / Oracle | Database load and network, not an HTTP tier |

---

## 2. Sample-data framework

`SampleSlackConnector` implements the same contract as the real Slack connector (`users`, `channels`, `messages`, hashed JSONL records) and never calls Slack. `ConnectorRuntimeEngine` writes the files, so the bench exercises the path the team already has.

```bash
npm run bench:slack
```

Optional knobs:

```bash
npm run bench:slack -- --messages 50000 --concurrency 1,4,8
```

Output:

- JSONL shards under `data/bench/slack-sample/` (gitignored)
- Summary: `data/bench/slack-bench-report.json`

The default run has two profiles:

1. **pipeline** — 20,000 messages, no delay. Runtime ceiling.
2. **api-wait** — 4,000 messages, 50 ms pause every 200 messages. Imitates waiting on one history page. Still more optimistic than Slack’s real tier cap.

---

## 3. Results on this machine

Run: `npm run bench:slack` (Node, local disk, sample data).

### Pipeline (no API wait) — 20,000 messages, ~15 MB JSONL

| Workers | Elapsed | Records/sec | RSS |
|---|---|---|---|
| 1 | 113 ms | 176,239 | 142 MB |
| 4 | 105 ms | 190,931 | 209 MB |

Four workers barely beat one. At this size the job is already so short that process overhead dominates. The runtime is not the bottleneck.

### API-wait (50 ms per 200 messages) — 4,000 messages

| Workers | Elapsed | Records/sec |
|---|---|---|
| 1 | 1,078 ms | 3,711 |
| 4 | 268 ms | 14,933 |

Here concurrency helps, because each worker waits on its own pages at the same time. That only translates to a real Slack workspace if each worker has an **independent** rate-limit budget. One shared bot token does not.

### How to read this in the demo

1. Show the pipeline table: “our extract loop is fast.”
2. Show the API-wait table: “as soon as we wait on pages, throughput drops by an order of magnitude, and workers help only if the source allows parallel calls.”
3. Put the Slack planning number next to both: **~170 messages/second per workspace**, not 176,000.

---

## 4. What to say if someone asks “how much concurrent data can a connector handle?”

- **Locally**, this Slack-shaped pipeline handled 20,000 records in about 0.1 s (about 15 MB) on one process.
- **Against Slack**, expect on the order of **10,000 messages per minute per workspace** if you stay inside Tier 3, then back off on `429`.
- **Scaling out** (one Docker container per connector, Kafka workers) scales **different connectors** and **different tenants**. It does not scale one Slack workspace past Slack’s quota.
