# Data Connector POC (Node.js)

Slack workspace extract + PostgreSQL catalog metadata extract, using the same shared contract (CLI → Runtime → Connector → output).

## Connectors

| Connector | Objects | Output |
|---|---|---|
| **slack** | workspaces, users, channels, messages, … | `data/output/slack/*.jsonl` |
| **postgres** | schemas, tables, views, columns | `data/output/postgres/*.jsonl` |

---

# Slack Connector

Extract Slack workspace data via OAuth-authenticated bot token.

## Security note

App credentials (Client Secret, Signing Secret) belong only in `.env` (gitignored).
If you pasted them into chat or a screenshot, **rotate Client Secret and Signing Secret** in Slack after you finish local setup.

Client ID / Secret alone cannot call data APIs. OAuth install produces the **bot token** (`xoxb-...`) the connector uses.

## 1. Configure Slack app

In [api.slack.com/apps](https://api.slack.com/apps) → your app:

### OAuth & Permissions → Redirect URLs

Add exactly:

```text
http://localhost:3000/slack/oauth/callback
```

### OAuth & Permissions → Bot Token Scopes

| Scope | Why |
|---|---|
| `channels:read` | List public channels |
| `channels:history` | Read public messages |
| `groups:read` | List private channels (bot must be member) |
| `groups:history` | Read private messages |
| `users:read` | List users |
| `usergroups:read` | User groups |
| `files:read` | File metadata only |
| `team:read` | Workspace info |

Optional: `users:read.email` if you need emails.

### Basic Information → App Credentials

Already loaded into local `.env` (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`).

## 2. Authenticate (OAuth install)

```bash
cd /Users/snikhil/Work/data-connector-app-poc
npm run auth
```

Open http://localhost:3000/slack/install → **Allow**.

This saves the bot token to `data/slack-auth.json` (gitignored).

```bash
npm run auth:status
npm run test:connection
```

## 3. Invite bot + extract

In Slack channels:

```text
/invite @YourBotName
```

Then:

```bash
npm run extract
npm run extract -- --objects users,channels
```

Output: `data/output/*.jsonl`

## Project layout

```text
src/
  auth-server.js                 OAuth install + callback
  cli.js                         test / extract commands
  connectors/slack/SlackOAuth.js
  connectors/slack/tokenStore.js
  connectors/slack/SlackClient.js
  connectors/slack/SlackConnector.js
  runtime/ConnectorRuntimeEngine.js
```

## What auth details are used for

| Credential | Used for |
|---|---|
| Client ID + Client Secret | OAuth code → bot token (`oauth.v2.access`) |
| Signing Secret | Verify Slack-signed HTTP requests (Events later) |
| Bot token (`xoxb-`) | All Web API extract calls |

File **binary** download remains out of scope; only file metadata is extracted.

---

# PostgreSQL Connector

Extract **database metadata** from PostgreSQL via `information_schema` (not table row data).

## 1. Database setup

Create a read-only role (example):

```sql
CREATE ROLE connector_reader LOGIN PASSWORD 'your-password';
GRANT CONNECT ON DATABASE appdb TO connector_reader;
GRANT USAGE ON SCHEMA public TO connector_reader;
-- metadata usually works with USAGE; add SELECT if your setup requires it
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

Either:

```env
POSTGRES_URL=postgresql://connector_reader:password@localhost:5432/appdb
```

Or:

```env
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=appdb
POSTGRES_USER=connector_reader
POSTGRES_PASSWORD=your-password
POSTGRES_SSL=false
# POSTGRES_SCHEMAS=public
```

## 3. Run

```bash
npm run test:postgres
npm run extract:postgres
npm run extract -- --connector postgres --objects schemas,tables,columns
```

Output: `data/output/postgres/schemas.jsonl`, `tables.jsonl`, `views.jsonl`, `columns.jsonl`

## Project layout (Postgres)

```text
connectors/postgres/PostgresClient.js    SQL + connection
connectors/postgres/PostgresConnector.js extract + normalise
config/connectors/postgres.json
```

Same flow as Slack:

```text
CLI → PostgresConnector → PostgresClient → PostgreSQL
                ↓
        ConnectorRuntimeEngine → data/output/postgres/
```
