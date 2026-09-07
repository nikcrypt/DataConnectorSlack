# Slack Connector (Node.js POC)

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
