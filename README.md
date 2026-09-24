# Data Connector POC (Node.js)

Slack workspace extract + PostgreSQL catalog metadata + SharePoint Online + Salesforce + Jira Cloud + Google Drive, using the same shared contract (CLI → Runtime → Connector → output).

## Connectors

| Connector | Objects | Output |
|---|---|---|
| **slack** | workspaces, users, channels, messages, … | `data/output/slack/*.jsonl` |
| **postgres** | schemas, tables, views, columns | `data/output/postgres/*.jsonl` |
| **sharepoint** | sites, lists, columns, listItems, drives, driveItems | `data/output/sharepoint/*.jsonl` |
| **salesforce** | sobjects, fields, records | `data/output/salesforce/*.jsonl` |
| **jira** | projects, issues, users, statuses, issueTypes | `data/output/jira/*.jsonl` |
| **googledrive** | drives, files, folders, permissions | `data/output/googledrive/*.jsonl` |

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
npm run test:slack
```

## 3. Invite bot + extract

In Slack channels:

```text
/invite @YourBotName
```

Then:

```bash
npm run extract:slack
npm run extract:slack -- --objects users,channels
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

---

# SharePoint Connector

Extract SharePoint Online site content via **Microsoft Graph** using **app-only** (client credentials) auth.

Objects:

| Object | Meaning |
|---|---|
| `sites` | Configured site metadata |
| `lists` | Lists in the site |
| `columns` | List column/schema definitions |
| `listItems` | List rows (`fields`) |
| `drives` | Document libraries |
| `driveItems` | Files/folders metadata (no binary download) |

## 1. Entra app registration

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → New registration  
2. Copy **Directory (tenant) ID** and **Application (client) ID**  
3. **Certificates & secrets** → create a client secret  
4. **API permissions** → Microsoft Graph → **Application** permissions:
   - `Sites.Read.All` (broad; needs admin consent), or  
   - `Sites.Selected` (narrower; grant site access separately)  
5. Click **Grant admin consent**

## 2. Configure `.env`

```env
SHAREPOINT_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
SHAREPOINT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
SHAREPOINT_CLIENT_SECRET=your-client-secret
SHAREPOINT_HOSTNAME=contoso.sharepoint.com
SHAREPOINT_SITE_PATH=/sites/engineering
```

`SHAREPOINT_SITE_PATH` is the server-relative site path (`/` for root site).

## 3. Run

```bash
npm run test:sharepoint
npm run extract:sharepoint
npm run extract -- --connector sharepoint --objects sites,lists,columns
```

Output: `data/output/sharepoint/*.jsonl`

## Project layout (SharePoint)

```text
connectors/sharepoint/SharePointClient.js     Graph + token
connectors/sharepoint/SharePointConnector.js  extract + normalise
config/connectors/sharepoint.json
```

```text
CLI → SharePointConnector → SharePointClient → Microsoft Graph → SharePoint
                ↓
        ConnectorRuntimeEngine → data/output/sharepoint/
```

---

# Salesforce Connector

Extract Salesforce metadata and records via the REST API using a Connected App.

| Object | Meaning |
|---|---|
| `sobjects` | Catalog of Salesforce objects |
| `fields` | Field describe for configured objects |
| `records` | SOQL rows for configured objects (default limit 200 each) |

## 1. Connected App setup

1. Salesforce Setup → **App Manager** → **New Connected App**
2. Enable **OAuth Settings**
3. Callback URL can be `https://login.salesforce.com/services/oauth2/success` for POC
4. Selected OAuth scopes: **Manage user data via APIs (api)** (and others as needed)
5. For password grant POC: enable allowing username-password (org policy permitting)
6. Or enable **Client Credentials Flow** for server-to-server (no username)
7. Save → copy **Consumer Key** (client id) and **Consumer Secret**

## 2. Configure `.env`

```env
SALESFORCE_LOGIN_URL=https://login.salesforce.com
# sandbox: https://test.salesforce.com
SALESFORCE_CLIENT_ID=...
SALESFORCE_CLIENT_SECRET=...

# Password grant (typical POC):
SALESFORCE_USERNAME=you@company.com
SALESFORCE_PASSWORD=your-password
SALESFORCE_SECURITY_TOKEN=your-security-token

# Which objects to describe/query:
SALESFORCE_OBJECTS=Account,Contact,Opportunity
SALESFORCE_RECORD_LIMIT=200
```

If `USERNAME`/`PASSWORD` are omitted, the connector tries **client_credentials**.

## 3. Run

```bash
npm run test:salesforce
npm run extract:salesforce
npm run extract -- --connector salesforce --objects sobjects,fields
npm run extract -- --connector salesforce --objects records
```

Output: `data/output/salesforce/*.jsonl`

## Project layout (Salesforce)

```text
connectors/salesforce/SalesforceClient.js
connectors/salesforce/SalesforceConnector.js
config/connectors/salesforce.json
```

```text
CLI → SalesforceConnector → SalesforceClient → Salesforce REST API
                ↓
        ConnectorRuntimeEngine → data/output/salesforce/
```

---

# Jira Connector

Extract Jira Cloud projects and issues via REST API v3 using email + API token.

| Object | Meaning |
|---|---|
| `projects` | Jira projects |
| `issues` | Issues via JQL (default: recently updated) |
| `users` | Users (needs Browse users permission) |
| `statuses` | Global statuses |
| `issueTypes` | Issue types |

## 1. Create API token

1. Go to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)  
2. **Create API token** → copy it  
3. Use your Atlassian account email + this token (Basic auth)

## 2. Configure `.env`

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-api-token
# Optional:
# JIRA_JQL=project = ABC ORDER BY updated DESC
# JIRA_MAX_ISSUES=500
```

## 3. Run

```bash
npm run test:jira
npm run extract:jira
npm run extract -- --connector jira --objects projects,issues
```

Output: `data/output/jira/*.jsonl`

## Project layout (Jira)

```text
connectors/jira/JiraClient.js
connectors/jira/JiraConnector.js
config/connectors/jira.json
```

```text
CLI → JiraConnector → JiraClient → Jira Cloud REST API
                ↓
        ConnectorRuntimeEngine → data/output/jira/
```

---

# Google Drive Connector

Extract Drive metadata (not file bytes) via Drive API v3.

| Object | Meaning |
|---|---|
| `drives` | My Drive + shared drives |
| `files` | Non-folder file metadata |
| `folders` | Folder metadata |
| `permissions` | ACL entries for a limited set of files |

## 1. Auth options

**A. Service account (typical POC)**

1. Google Cloud Console → create a project → enable **Google Drive API**
2. Create a **service account** → download JSON key → save as `certs/google-sa.json`
3. Share the Drive folders/files you want with the service account email (`...@....iam.gserviceaccount.com`), **Viewer**
4. (Workspace only) For full user Drive access without sharing each folder: enable domain-wide delegation and set `GOOGLE_IMPERSONATE_USER`

**B. OAuth refresh token**

Create an OAuth client (Desktop or Web), complete consent once, store refresh token:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

**C. Short-lived bearer**

```env
GOOGLE_ACCESS_TOKEN=ya29....
```

## 2. Configure `.env`

```env
GOOGLE_SERVICE_ACCOUNT_FILE=./certs/google-sa.json
# GOOGLE_IMPERSONATE_USER=user@company.com
# GOOGLE_DRIVE_MAX_FILES=2000
# GOOGLE_DRIVE_PERMISSION_FILE_LIMIT=50
# GOOGLE_DRIVE_QUERY=name contains 'report'
```

## 3. Run

```bash
npm run test:googledrive
npm run extract:googledrive
npm run extract -- --connector googledrive --objects drives,files,folders
```

Output: `data/output/googledrive/*.jsonl`

## Project layout (Google Drive)

```text
connectors/googledrive/GoogleDriveClient.js
connectors/googledrive/GoogleDriveConnector.js
config/connectors/googledrive.json
```

```text
CLI → GoogleDriveConnector → GoogleDriveClient → Drive API v3
                ↓
        ConnectorRuntimeEngine → data/output/googledrive/
```
