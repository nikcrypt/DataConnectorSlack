# Data Connector POC (Node.js)

Slack workspace extract + PostgreSQL, MySQL, and Oracle catalog metadata + SharePoint Online + Salesforce + Jira Cloud + Google Drive + Box + Confluence + one Windows or SMB folder, using the same shared contract (CLI → Runtime → Connector → output).

QA can run every connector from one container. See [docs/qa-docker.md](docs/qa-docker.md). Splitting one container per connector is the later platform step.

## Connectors

| Connector | Objects | Output |
|---|---|---|
| **slack** | workspaces, users, channels, messages, … | `data/output/slack/*.jsonl` |
| **postgres** | schemas, tables, views, columns | `data/output/postgres/*.jsonl` |
| **mysql** | schemas, tables, views, columns | `data/output/mysql/*.jsonl` |
| **oracle** | schemas, tables, views, columns | `data/output/oracle/*.jsonl` |
| **sharepoint** | sites, lists, columns, listItems, drives, driveItems | `data/output/sharepoint/*.jsonl` |
| **salesforce** | sobjects, fields, records | `data/output/salesforce/*.jsonl` |
| **jira** | projects, issues, users, statuses, issueTypes | `data/output/jira/*.jsonl` |
| **googledrive** | drives, files, folders, permissions | `data/output/googledrive/*.jsonl` |
| **box** | users, folders, files, collaborations | `data/output/box/*.jsonl` |
| **confluence** | spaces, pages, blogposts, attachments | `data/output/confluence/*.jsonl` |
| **windows** | folders, files | `data/output/windows/*.jsonl` and `data/output/windows/downloads/` |

## Docker

Run these from the project folder. Docker Desktop must be running. The plaintext `.env` stays in that folder. It is not copied into the image. Compose passes those values in when the container starts. The container exits when the command finishes. **Exited (0)** means it succeeded. Output is written to `data/output/<connector>/` on the machine.

Build:

```bash
docker compose build
```

Test:

```bash
docker compose run --rm connectors npm run test:slack
docker compose run --rm connectors npm run test:postgres
docker compose run --rm connectors npm run test:mysql
docker compose run --rm connectors npm run test:oracle
docker compose run --rm connectors npm run test:sharepoint
docker compose run --rm connectors npm run test:salesforce
docker compose run --rm connectors npm run test:jira
docker compose run --rm connectors npm run test:googledrive
docker compose run --rm connectors npm run test:box
docker compose run --rm connectors npm run test:confluence
docker compose run --rm connectors npm run test:windows
```

Extract to JSONL:

```bash
docker compose run --rm connectors npm run extract:slack
docker compose run --rm connectors npm run extract:postgres
docker compose run --rm connectors npm run extract:mysql
docker compose run --rm connectors npm run extract:oracle
docker compose run --rm connectors npm run extract:sharepoint
docker compose run --rm connectors npm run extract:salesforce
docker compose run --rm connectors npm run extract:jira
docker compose run --rm connectors npm run extract:googledrive
docker compose run --rm connectors npm run extract:box
docker compose run --rm connectors npm run extract:confluence
docker compose run --rm connectors npm run extract:windows
```

Save any connector to MongoDB. Each one uses database `data_connector_<name>`:

```bash
docker compose run --rm connectors npm run extract:slack:mongo
docker compose run --rm connectors npm run extract:jira:mongo
docker compose run --rm connectors npm run extract:postgres:mongo
```

Rebuild after code changes, then run the command again. Limit objects by appending the same flags used locally:

```bash
docker compose run --rm connectors npm run extract:jira -- --objects projects,issues
```

Share the image with QA:

```bash
docker save data-connector-app-poc -o data-connector-app-poc.tar
```

QA installs Docker Desktop. They do not need npm or Node installed. Put the tar and `.env.enc` in one folder. Load the image, then decrypt `.env` with the script already inside the image:

```bash
docker load -i data-connector-app-poc.tar
docker run --rm -it -v "$PWD:/work" -w /work data-connector-app-poc node /app/src/secrets/envFileCrypto.js decrypt
```

That asks for the passphrase and writes a plaintext `.env` in the same folder. If `.env` is already there, add `--force` at the end. Then run a connector:

```bash
docker run --rm --env-file .env -v "$PWD/data:/app/data" -v "$PWD/certs:/app/certs" -p 3000:3000 data-connector-app-poc npm run test:jira
```

On Windows, use `%cd%` instead of `$PWD`. Replace `test:jira` with any `test:` or `extract:` command above.

---

# Slack Connector

Extract Slack workspace data via OAuth-authenticated bot token.

## Security note

App credentials (Client Secret, Signing Secret) belong only in `.env` (gitignored).

Encrypt a copy when you need to store or share it. The passphrase stays in a password manager, not in the repo:

```bash
npm run env:encrypt
npm run env:decrypt
```

Docker and the CLI still read plaintext `.env` at run time. Decrypt before `docker compose run`. The image does not contain `.env` or `.env.enc`.
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

To save an extract into MongoDB (`records` and `extraction_runs` in `data_connector_<connector>`):

```bash
npm run extract:slack:mongo
npm run extract:slack:mongo -- --objects users,channels
npm run extract:jira:mongo
npm run extract:postgres:mongo
```

## Project layout

```text
src/
  auth-server.js                 OAuth install + callback
  cli.js                         test / extract commands
  connectors/slack/SlackOAuth.js
  connectors/slack/tokenStore.js
  connectors/slack/SlackClient.js
  connectors/slack/SlackConnector.js
  runtime/ConnectorRuntimeEngine.js   JSONL writer
  runtime/MongoRuntime.js            every connector -> MongoDB
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

# Oracle Connector

Extract **database metadata** from Oracle via `ALL_*` catalog views (not table row data). Uses `node-oracledb` thin mode, so Oracle Instant Client is not required.

## 1. Configure `.env`

```env
ORACLE_USER=app_reader
ORACLE_PASSWORD=your-password
ORACLE_CONNECT_STRING=localhost:1521/XEPDB1
# ORACLE_SCHEMAS=HR,APP
```

Or host parts instead of a connect string:

```env
ORACLE_HOST=localhost
ORACLE_PORT=1521
ORACLE_SERVICE_NAME=XEPDB1
```

The account needs `SELECT` on the objects you want listed (`ALL_TABLES`, `ALL_VIEWS`, `ALL_TAB_COLUMNS`, `ALL_OBJECTS`).

## 2. Run

```bash
npm run test:oracle
npm run extract:oracle
npm run extract -- --connector oracle --objects schemas,tables,columns
```

Output: `data/output/oracle/*.jsonl`

## Project layout (Oracle)

```text
connectors/oracle/OracleClient.js
connectors/oracle/OracleConnector.js
config/connectors/oracle.json
```

```text
CLI → OracleConnector → OracleClient → Oracle Database
                ↓
        ConnectorRuntimeEngine → data/output/oracle/
```

---

# MySQL Connector

Extract **database metadata** from MySQL via `information_schema` (not table row data). System schemas `mysql`, `information_schema`, `performance_schema`, and `sys` are skipped unless you list them in `MYSQL_SCHEMAS`.

## 1. Configure `.env`

```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DATABASE=appdb
MYSQL_USER=connector_reader
MYSQL_PASSWORD=your-password
MYSQL_SSL=false
# MYSQL_SCHEMAS=appdb
```

Or a URL:

```env
MYSQL_URL=mysql://connector_reader:password@localhost:3306/appdb
```

## 2. Run

```bash
npm run test:mysql
npm run extract:mysql
npm run extract -- --connector mysql --objects schemas,tables,columns
```

Output: `data/output/mysql/*.jsonl`

## Project layout (MySQL)

```text
connectors/mysql/MysqlClient.js
connectors/mysql/MysqlConnector.js
config/connectors/mysql.json
```

```text
CLI → MysqlConnector → MysqlClient → MySQL
                ↓
        ConnectorRuntimeEngine → data/output/mysql/
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
| `records` | SOQL rows for configured objects (up to 10,000 each) |

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
SALESFORCE_RECORD_LIMIT=10000
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
npm run extract:jira:mongo
```

File output: `data/output/jira/*.jsonl`. `extract:jira:mongo` writes the same records to MongoDB database `data_connector_jira`.

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

**B. OAuth (browser sign-in)**

Set the OAuth client and the redirect URL registered on that client:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

When the access token or refresh token is expired, `npm run test:googledrive` opens Google's login screen, stores a new refresh token in `data/google-auth.json`, and retries. You can also sign in first:

```bash
npm run auth:googledrive
```

On a VM, publish port 3000 and open the printed URL in a browser on your laptop. `http://localhost:3000/oauth2callback` must be an authorized redirect URI on the Google OAuth client.

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

---

# Box Connector

Extract Box metadata (not file bytes) via Box API v2.

| Object | Meaning |
|---|---|
| `users` | Enterprise users (falls back to current user) |
| `folders` | Folder tree from root (BFS) |
| `files` | File metadata under that tree |
| `collaborations` | ACL / collab entries on sampled folders |

## 1. Auth options

**A. Developer token (fastest POC)**

1. [Box Developer Console](https://app.box.com/developers/console) → your app → **Configuration**
2. Generate a **Developer Token** (expires in ~60 minutes)
3. Set `BOX_ACCESS_TOKEN`

**B. Client Credentials Grant (server app)**

1. Create a Custom App with **Server Authentication (Client Credentials Grant)**
2. Authorize the app in Admin Console
3. Set `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_ENTERPRISE_ID`

**C. OAuth refresh token**

```env
BOX_CLIENT_ID=...
BOX_CLIENT_SECRET=...
BOX_REFRESH_TOKEN=...
```

## 2. Configure `.env`

```env
BOX_ACCESS_TOKEN=your-developer-token
# BOX_ROOT_FOLDER_ID=0
# BOX_MAX_DEPTH=5
# BOX_MAX_ITEMS=2000
```

## 3. Run

```bash
npm run test:box
npm run extract:box
npm run extract -- --connector box --objects folders,files
```

Output: `data/output/box/*.jsonl`

## Project layout (Box)

```text
connectors/box/BoxClient.js
connectors/box/BoxConnector.js
config/connectors/box.json
```

```text
CLI → BoxConnector → BoxClient → Box API v2
                ↓
        ConnectorRuntimeEngine → data/output/box/
```

---

# Confluence Connector

Extract Confluence Cloud spaces, pages, blog posts, and attachment metadata via REST API v2.

| Object | Meaning |
|---|---|
| `spaces` | Confluence spaces |
| `pages` | Pages plus a plain-text body excerpt |
| `blogposts` | Blog posts plus a plain-text body excerpt |
| `attachments` | Attachment metadata for a limited set of pages (no file bytes) |

Auth is the same Atlassian email + API token as Jira. If `CONFLUENCE_*` is unset, the connector reuses `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`.

## 1. Configure `.env`

```env
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
CONFLUENCE_EMAIL=you@company.com
CONFLUENCE_API_TOKEN=your-api-token
# CONFLUENCE_MAX_PAGES=500
# CONFLUENCE_MAX_BLOGPOSTS=200
```

## 2. Run

```bash
npm run test:confluence
npm run extract:confluence
npm run extract -- --connector confluence --objects spaces,pages
```

Output: `data/output/confluence/*.jsonl`

## Project layout (Confluence)

```text
connectors/confluence/ConfluenceClient.js
connectors/confluence/ConfluenceConnector.js
config/connectors/confluence.json
```

```text
CLI → ConfluenceConnector → ConfluenceClient → Confluence Cloud REST API v2
                ↓
        ConnectorRuntimeEngine → data/output/confluence/
```

---

# Windows folder

Reads one folder URL. It does not read a whole drive or an admin share such as `C$`.

```env
WINDOWS_FOLDER_URL=smb://fileserver/team/reports
WINDOWS_USERNAME=reader
WINDOWS_PASSWORD=your-password
WINDOWS_DOMAIN=WORKGROUP
```

A folder that is already mounted on this machine:

```env
WINDOWS_FOLDER_URL=file:///path/to/folder
```

```bash
npm run test:windows
npm run extract:windows
```

File records land in `data/output/windows/files.jsonl`. Files at or under 5 MB are copied to `data/output/windows/downloads/`. Larger files are listed and skipped.
