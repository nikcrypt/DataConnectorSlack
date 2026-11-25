# Connector API - foundation and local authentication

## Dashboard summary

`GET /api/v1/dashboard/summary` requires an API session and a configured MongoDB
database. It returns `{ data, requestId }`, where `data` contains:

```json
{
  "range": "7d",
  "connections": 1,
  "extractions": { "total": 20, "succeeded": 18, "failed": 1, "running": 1 },
  "recordsExtracted": 31810,
  "lastFailedAt": "2026-11-12T10:00:00.000Z"
}
```

The fixed range is the previous 168 hours, using runs with `startedAt` greater
than or equal to the range start and before the request's current time. Counts
come from `extraction_runs`; records are summed from `objects.<object>.extracted`,
including any saved partial counts on failed runs. Running counts reflect the
stored run status, not a live process check. Repeated extractions are counted
again; this is not a count of unique source records. `lastFailedAt` is the latest
`finishedAt` among failed runs in this range, or `null` when none is recorded.
Other statuses contribute to `total` but not to the three named status counts.

`connections` counts all documents in `connections`, independent of the seven-day
range. An absent or empty collection returns zero; connector config files and
run history are not treated as registered connections. This branch does not yet
create connection records.

There is deliberately no user filter yet: every authenticated caller receives
the application-wide summary. Add ownership-based filtering before exposing a
personal dashboard across users. No query parameters are needed. With no runs,
run counts and extracted records are zero. Without MongoDB, this endpoint returns
503 `DATABASE_UNAVAILABLE`; database query failures use the existing safe error
handler. Authentication and other endpoints continue to work without MongoDB.

The query reads only run status, finish time and object counts, and processes
results in batches rather than loading every run into an array. For large run
histories, provision an index on `{ startedAt: -1 }` in `extraction_runs` and
verify the query with `explain("executionStats")`. The runtime's compound index
starting with `connectorKey` is not a replacement for this unfiltered date query.
This endpoint does not create indexes or modify records.

`dashboard/dashboardService.js` contains the dashboard data queries and
calculations. Routes handle the HTTP responses. The reusable `requireDatabase()`
middleware checks database configuration on routes that need it. It does not
check live connectivity; query failures still use the existing error handler.
The activity placeholder does not require MongoDB yet.

## Connection registration (Jira + Slack + Oracle)

Requires a valid API session cookie and MongoDB (`MONGO_URL` / `MONGODB_URI`
with a database name). Routes live in `connections/router.js`; persistence is in
`connections/connectionsService.js` (MongoDB collection `connections`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/connections/meta` | Field schema for the FE register form |
| `POST` | `/api/v1/connections` | Register a Jira, Slack, or Oracle connection |

`POST` requires role `admin` or permission `connectors.configure`. Without MongoDB
it returns `503 DATABASE_UNAVAILABLE`.

### Register Jira

```json
{
  "connector": "jira",
  "userId": "user-123",
  "name": "Jira · Engineering",
  "baseUrl": "https://your-team.atlassian.net",
  "email": "you@company.com",
  "apiToken": "atlassian-api-token",
  "authType": "api_token",
  "objects": ["projects", "issues", "users", "statuses", "issueTypes"]
}
```

Aliases: `endpoint` → `baseUrl`, `account` → `email`, `secret` → `apiToken`,
`user_id` / `userid` → `userId`.

### Register Slack

```json
{
  "connector": "slack",
  "userId": "user-123",
  "name": "Slack · Aziro",
  "workspaceUrl": "https://your-workspace.slack.com",
  "account": "you@company.com",
  "botToken": "xoxb-…",
  "userToken": "xoxp-…",
  "authType": "bot_token",
  "objects": ["workspaces", "users", "channels", "messages", "files"],
  "channelIds": ["C01234567"],
  "historyDays": 30
}
```

- `botToken` is required (`xoxb-…`).
- `userToken`, `workspaceUrl`, `account`, `channelIds`, and `historyDays` are optional.
- Aliases: `bot_token` / `token` / `secret` → `botToken`, `user_token` → `userToken`,
  `endpoint` / `baseUrl` → `workspaceUrl`.

### Register Oracle

```json
{
  "connector": "oracle",
  "userId": "user-123",
  "name": "Oracle · HR",
  "username": "app_reader",
  "password": "your-password",
  "connectString": "localhost:1521/XEPDB1",
  "authType": "database_credentials",
  "objects": ["schemas", "tables", "views", "columns"],
  "schemas": ["HR"],
  "pageSize": 1000
}
```

Or without `connectString`:

```json
{
  "connector": "oracle",
  "userId": "user-123",
  "name": "Oracle · HR",
  "username": "app_reader",
  "password": "your-password",
  "host": "localhost",
  "port": 1521,
  "serviceName": "XEPDB1",
  "objects": ["schemas", "tables", "views", "columns"]
}
```

- Required: `username`, `password`, and either `connectString` or `host` + (`serviceName` or `sid`).
- Optional: `schemas`, `schemaName`, `tableName`, `tablesSpec`, `pageSize`, `modifiedColumn`.
- Aliases: `user` → `username`, `secret` → `password`, `connect_string` / `endpoint` → `connectString`.

### Successful response (201)

Secrets are stored in MongoDB but never returned. Responses include `hasSecret`
(and for Slack, `hasUserToken`). This path does not call Slack/Jira on create.
List/update/delete/test/extract endpoints are not implemented in this slice.

## Dashboard and extraction-history placeholders

These GET endpoints require a valid API session cookie and return HTTP 200:

| Endpoint | Empty `data` |
| --- | --- |
| `/api/v1/dashboard/activity` | `{ "series": [], "buckets": [] }` |
| `/api/v1/extractions` | `{ "items": [], "nextCursor": null, "hasMore": false }` |
| `/api/v1/extractions/:runId` | `null` |

Every placeholder response includes `data` and the server-generated `requestId`,
which also appears in `X-Request-ID`. For example:

```json
{
  "data": null,
  "requestId": "server-generated-uuid"
}
```

Empty data is currently a placeholder, not an assertion that no connections or
runs exist. Apart from the summary above, no dashboard database queries,
connector calls, filter/pagination processing or run lookup are implemented. In particular,
`/:runId` returns the same placeholder for any matching path parameter; it does
not check whether a run exists yet. Missing/invalid sessions use the existing
401 error response. Future real-data implementations must enforce data access
permissions as well as login.

Routes live in `dashboard/router.js` and `extractions/router.js`. The app mounts
both behind the existing `requireAuth()` middleware. No runtime changes are needed.

## Start the API

Run from the repository root:

```sh
npm install
npm run api
```

The API is a separate process. It does not start extraction jobs, initialize
connector clients or start the existing settings server.
Existing CLI commands are unchanged.
Before starting, provision the hashed users file described below and configure
`API_CORS_ORIGINS` for the frontend. Authentication configuration is now required
at startup; no example users are created automatically.

## Shared MongoDB connection

When `MONGO_URL` or `MONGODB_URI` is configured, API startup opens one MongoDB
client and checks connectivity before accepting requests. `MONGO_URL` takes
priority. The URI must include a database name, for example
`mongodb://127.0.0.1:27017/data_connector`. Without either variable, the API
continues to support file-based authentication and the existing placeholders.

`src/storage/mongodbConfig.js` reads these settings and sets a maximum pool size
of 10, five-second connection/selection/pool-wait timeouts and a ten-second
operation timeout. These are defaults, not benchmark results.
`src/storage/mongodbConnection.js` returns `{ db, close }`. Startup owns the
connection and closes it on startup failure or shutdown. Initialization errors
do not include the connection string or credentials.

The dashboard receives the existing `db` handle through function arguments,
rather than opening a client per request or using `app.locals`. Future services
should use the same approach. Calling
`openMongoDatabase()` again creates another client; there is no global cache.
Each API process has its own pool. The extraction runtime still uses its
existing MongoDB setup and has not been changed.

## Configuration

The entry point uses the existing dotenv dependency to load `.env` from the
working directory. Environment variables already set in the process take
priority. `.env.local` is not loaded by this entry point.

Optional settings (these are also the defaults):

```dotenv
API_HOST=127.0.0.1
API_PORT=3081
API_CORS_ORIGINS=
API_BODY_LIMIT_BYTES=102400
API_RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT_MAX=100
API_REQUEST_TIMEOUT_MS=30000
```

`API_HOST` must be a local bind IP address or `localhost`; do not include a URL
scheme or port. `API_PORT` must be an integer from 1 to 65535. Empty or invalid
values stop startup. The API does not use the existing `PORT` or `SETTINGS_PORT`.

`API_CORS_ORIGINS` is a comma-separated list of exact frontend origins, for
example `http://localhost:5173,https://connectors.example.com`. Do not include
paths, trailing slashes, credentials, wildcards or `null`. An empty list allows
no browser origins. Requests without an Origin header can reach health and `/me`,
but login/logout require an explicitly allowed Origin, including for curl/Postman.
Credentialed CORS is enabled only for allowed origins. Include the API origin too
if it also serves the frontend. Use the same hostname consistently in development
(do not mix localhost and 127.0.0.1 for frontend/API cookies).

Numeric limits must be positive whole numbers. Body size is measured in bytes
(default 100 KiB, maximum 10 MiB); the rate window is in milliseconds (default
60 seconds, maximum 1 hour); the request allowance defaults to 100 (maximum
100000); HTTP timeouts default to 30 seconds (maximum 5 minutes). These upper
bounds are configuration safeguards, not measured capacity guarantees.

PowerShell example:

```powershell
$env:API_PORT = "3082"
npm run api
```

The default address accepts connections only from this machine. A container
deployment normally needs `API_HOST=0.0.0.0`, which listens on all IPv4 interfaces;
restrict network access before using it.

## Current behavior

Startup validates auth configuration, reads the provisioned accounts and prepares
the session file before printing `[api] Listening on http://127.0.0.1:3081`.
`GET /api/v1/health` remains public and returns `{"status":"ok"}`; it is not a
database or connector readiness check. Auth routes are listed below. Unknown
routes return 404. Dashboard and extraction-history routes are authenticated
placeholders, described below. Connection-management and extraction execution
routes are not added.

## Request handling

Requests pass through these steps in order:

1. Generate a request ID and register one completion/aborted log entry.
2. Apply Helmet security headers and `Cache-Control: no-store`.
3. Check the frontend Origin against the configured allowlist.
4. Apply the per-IP request limit, including permitted OPTIONS requests.
5. Complete permitted OPTIONS preflight requests with HTTP 204.
6. Require JSON for non-empty bodies and parse at most the configured byte limit.
7. Run health/auth routes, then the 404 fallback and error handler.

JSON bodies must be objects or arrays, not standalone scalar values. Compressed
bodies are rejected. Auth request validation is in `auth/authValidations.js`;
the login route rejects arrays and unsupported fields.

Errors returned by Express use this shape:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "API endpoint not found.",
    "requestId": "server-generated-uuid"
  }
}
```

The same ID appears in the `X-Request-ID` response header and request log.
Client-supplied request IDs are not trusted. Logs omit URLs, query strings,
headers, bodies and raw exception messages to avoid leaking credentials or JQL.
Unexpected failures get a generic 500 response and a correlated error log;
debugging the underlying cause may require a controlled local reproduction.

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON or incomplete request body |
| 401 | Invalid login credentials or missing/expired session |
| 403 | Origin is not allowed |
| 404 | Endpoint does not exist |
| 413 | JSON body exceeds the size limit |
| 415 | Unsupported content type, character encoding or compression |
| 429 | Request limit exceeded; `Retry-After` indicates when to retry |
| 500 | Unexpected API error; internal details are not returned |
| 503 | Configured accounts cannot be loaded for sign-in |

The limiter uses an in-process memory store, suitable for this single API
instance. Restarting clears counters; multiple replicas need a shared store or
gateway limit. Users behind one shared public IP share the allowance (IPv6
addresses use the library's subnet grouping). This limits API calls, not Jira
requests or concurrent extractions. It is not complete denial-of-service protection.

`trust proxy` stays false. Do not enable it globally to fix a proxy warning:
configure trusted proxy addresses only after the deployment topology is known.
Otherwise client-controlled forwarding headers can undermine IP-based limits.
Behind a proxy, clients may share the proxy's allowance until this is configured.

The server allows up to 10 seconds to receive headers (or the configured HTTP
timeout if shorter), the configured timeout to receive a complete request, and
5 seconds of idle keep-alive. Active sockets also have the configured inactivity
timeout. Node.js may return a plain 408 or close a timed-out connection outside
Express; those failures do not guarantee the JSON error shape or a request ID.
These are HTTP timeouts, not a deadline or cancellation mechanism for extraction
jobs. Future extraction endpoints should return a run ID and process jobs outside
the HTTP request. A reverse proxy must also have appropriate limits and TLS.

Ctrl+C or SIGTERM stops accepting new connections and allows active requests to
finish. If shutdown takes longer than 10 seconds, the process exits with code 1.
Invalid configuration and startup failures also exit with code 1.

## Files

- `app.js`: creates the Express application without opening a port.
- `config.js`: reads and validates API settings.
- `middleware.js`: request IDs, safe request logs and consistent error responses.
- `server.js`: loads the environment and handles server startup and shutdown.
- `auth/router.js`: login, logout and current-user routes.
- `auth/authValidations.js`: auth Origin and request-body checks.
- `auth/requireAuth.js`: reads the API cookie and requires an unexpired session.
- `auth/service.js`: verifies credentials using the existing local accounts.
- `auth/sessionStore.js`: persists API sessions in a single-process JSON file.

Keep connector and runtime imports out of the API foundation. Later API routes
should call application services with explicit inputs rather than duplicate
extraction logic.

## Local authentication - auth phases 1 to 3

Phase 1 prepared credential verification and file sessions. Phase 2 integrates
login, logout and `/me`, session cookies, login throttling and Origin checks.
Phase 3 verifies the integration and documents setup, troubleshooting and limits.
These phases do not implement Entra, connector authorization or connection ownership.

`auth/service.js` exports `createAuthService()`. It calls the existing
`settings/rbac.js` functions instead of introducing a second password format or
role system. `authenticate(username, password)` remains available to the settings
server with its existing initialization/migration behavior. Password comparison
now uses asynchronous scrypt with the same salt, key length and comparison as
before, so existing generated password hashes remain usable. Explicit provisioning
and legacy migration still use the existing synchronous `hashPassword()` helper.
API login uses `authenticate(email, password, { users, loginField: "email" })`.
The default remains username login for the existing settings server. Account
loading and legacy migrations preserve the optional email field.

The API uses `loadUsers({ initialize: false, filePath })`: it only reads the file,
never copies example accounts, migrates entries or writes passwords. It rejects
missing files, invalid JSON, empty lists, duplicate usernames, plaintext passwords,
legacy editor accounts, unknown roles and malformed salts/hashes. The accepted
format is the existing generated format: a 32-hex-character salt and a
128-hex-character password hash, with `admin` or `viewer` as the role.
Add an `email` to accounts intended for API login. Emails are trimmed and matched
case-insensitively; malformed or duplicate configured emails are rejected. Accounts
without email remain usable by the settings login but cannot sign in to the API.
No email address is inferred from a username or added to real accounts automatically.

Provision accounts deliberately using the existing password-hashing helper and
protect the users file with operating-system permissions. Replace any known
example/default passwords before enabling login. Hashing an example password
does not make that password safe. This phase does not create or alter user files.

Authentication configuration is loaded by `loadAuthConfig()` before the server
listens. These settings have defaults; the provisioned users file is required:

```dotenv
API_AUTH_USERS_FILE=data/rbac-users.json
API_SESSION_FILE=data/api-sessions.json
API_SESSION_TTL_SECONDS=43200
API_LOGIN_RATE_LIMIT_WINDOW_MS=900000
API_LOGIN_RATE_LIMIT_MAX=10
```

Both file paths are resolved relative to the working directory and must be different.
The session file is created automatically; the users file must already exist. Session TTL
must be 1-86400 seconds (default 12 hours). There is no maximum session count.
`API_SESSION_COOKIE_SECURE` accepts only `true` or `false` and defaults to false.
This setting does not depend on `NODE_ENV`. Set it to true for HTTPS deployments,
including production and staging. The API no longer rejects false based on the
environment name; deployment configuration must set the correct value explicitly.

Session cookies use the name `connector_api_session`,
`HttpOnly`, `SameSite=Lax`, path `/api/v1`, no Domain attribute, and a Max-Age
matching the server-side session TTL. This name is different from the settings
UI's `settings_session`. Cookies are not isolated by port: do not treat services
on the same hostname as separate browser security boundaries. This plan assumes
same-site frontend/API deployment; cross-site deployment needs explicit review.
The browser must use `credentials: "include"` for login, logout and `/me` calls.

Internal usage (not an HTTP endpoint):

```javascript
const auth = await createAuthService();
const user = await auth.authenticateCredentials(email, password);
if (user) {
  const session = await auth.sessions.createSession(user);
  // The login route sends the token in an HttpOnly cookie, not in JSON or logs.
}
// On application shutdown:
await auth.sessions.close();
```

`authenticateCredentials()` accepts an email with basic syntax validation up to
254 characters and a non-empty password up to 1024 UTF-8 bytes. It trims and
lowercases email, not passwords. It does not verify mailbox ownership. It reads
accounts again for each attempt and returns `{ username, displayName, email, role, permissions }` internally
or null for invalid credentials. The username remains the existing account
identifier and is also returned for frontend display. Unknown users also go through password derivation to
avoid an immediate missing-user response; this does not guarantee identical
timing or replace login throttling. The optional `users` argument in the shared
verifier is for trusted server code only, never request-supplied user records.

The service reports `INVALID_LOGIN_INPUT` for malformed credentials and
`AUTH_CONFIGURATION_ERROR` for missing/invalid account configuration, without
including account data or raw file-parser errors. Routes return 400 for invalid
input and 503 for account-configuration failures. File-session failures use the
generic 500 response, without paths or file contents.

`auth/sessionStore.js` retains the existing create, lookup and logout flow but
persists API sessions in a JSON file. `src/settings/sessions.js` remains unchanged.
Store creation and every session method must be awaited. Tokens are 24 random
bytes encoded as 48 hex characters; only their SHA-256 hashes are saved to disk.
Each record contains `tokenHash`, `username`, `displayName`, `email`, `role`, `permissions` and `expiresAt`
(epoch milliseconds). The internal username is preserved for compatibility.
The original token is returned internally only when creating a session, for the cookie.

Each operation reads the file. Creation and logout save the updated list before
returning. Operations are serialized within this store to avoid lost updates.
Saves write a temporary file in the same directory and rename it over the session
file, avoiding an in-place partial JSON write. This is not a power-loss durability
guarantee. Invalid JSON or malformed records cause an error, not a silent reset.
Read/write failures propagate to the caller; a failed save is not reported as success.

`getSession()` returns username, displayName, email, role, permissions and expiry internally, or null for an unknown or
expired token. Reads never extend expiry. Expired entries are removed at startup
and on login/logout writes; there is no cleanup timer. While idle, expired entries
can remain on disk but cannot authenticate. `close()` rejects new operations and
waits for queued work; it does not delete saved sessions. Restarting with the same
file preserves unexpired sessions. Routes await these methods; the server calls
`close()` after active requests finish during shutdown or after startup failure.
Username-only API sessions from before the email-login change are discarded when
loading the store. Those users must sign in again. New email sessions continue
to survive restart; existing settings sessions are unchanged.

Use exactly one store in one API process per session file. Multiple processes or
replicas sharing the file are unsupported; there is no cross-process locking.
This is a small-deployment solution: lookups read the full JSON file and writes
rewrite it. There is no maximum session count. Login rate limiting runs before
password verification. Containers need a persistent volume for this file.
The default `data/` folder is already gitignored. Keep custom paths out of version
control and public/static directories. File writes request owner-only permissions
on POSIX; configure Windows folder ACLs so only the service account and trusted
administrators can access it. Hashed tokens do not protect against someone who can
modify the session file.

Active sessions currently retain the role and permissions loaded at login. After changing a
user's password/role/permissions or removing an account, stop the API, remove the session file,
then restart to invalidate all sessions. Restart alone no longer logs users out.
Immediate per-user revocation is not implemented in this phase. Newly
attempted logins read the updated users file. There is no Entra integration,
password-reset endpoint or user-management API in this local-auth foundation.

## Authentication endpoints - phase 2

| Method and path | Input | Successful response |
| --- | --- | --- |
| `POST /api/v1/auth/login` | JSON with only `email` and `password`; allowed Origin | 200 with public user, expiry and session cookie |
| `GET /api/v1/auth/me` | Session cookie | 200 with public user and expiry |
| `POST /api/v1/auth/logout` | Session cookie if present; allowed Origin; no body or `{}` | 200 and cleared cookie |

Login and `/me` return:

```json
{
  "data": {
    "user": {
      "username": "manoj",
      "displayName": "Manoj Kumar",
      "email": "manoj@example.com",
      "role": "admin",
      "permissions": ["workspace.view", "connectors.read", "connectors.configure", "extractions.run"]
    },
    "expiresAt": "2026-11-13T00:00:00.000Z"
  },
  "requestId": "server-generated-uuid"
}
```

The expiry above is illustrative; it is calculated at login. No password, hash
or token is returned in JSON. Roles come from the provisioned account, never from
request fields. Arrays, extra login fields and invalid credential types/lengths
return 400. The old `username` login field is no longer accepted by the API.
Unknown emails and wrong passwords both return 401 with
`INVALID_CREDENTIALS` and `Invalid email or password.` Login and `/me` expose
username, displayName, email, role and configured permissions in `data.user`. Login still
accepts email/password only; returning username does not enable username login.

Account `displayName` is an optional string for frontend display. It is trimmed
and falls back to username when absent or blank. Account loading, legacy migrations
and API sessions preserve it. Existing sessions without a display name return
username as the fallback; sign out and sign in after configuring a displayName to
load it into the session. No real user accounts are rewritten automatically.

Account `permissions` is an optional array of non-empty strings. Entries are
trimmed and duplicates removed when loading accounts; missing permissions default
to `[]`. Explicit null, non-array values or invalid entries are configuration errors.
Legacy account migrations preserve the field. Permissions are copied into the
session at login and survive restart. Existing email sessions without this field
return `[]`; sign out and sign in to load the configured permissions. Editing the
users file does not refresh already-issued sessions. The API does not infer
permissions from the role or accept them from the login body. Returning them
supports frontend display; backend per-action permission enforcement is not added.

Each successful login creates a fresh token. If this browser supplied an existing
session token, it is removed after credentials are verified and before creating
the new session. Failed credential verification leaves the old session alone.
If replacement creation fails after removal, the user must sign in again.
Other browsers' sessions are not revoked. File writes must succeed before a
cookie or success response is sent.

`/me` uses `requireAuth()` to read exactly one valid API session cookie and verify
its expiry. Missing, malformed, duplicate, unknown or expired cookies return 401
`UNAUTHENTICATED`. A session-file read/parse failure returns 500, not a false 401.
`/me` does not extend expiry or re-read user roles. Other future protected routes
must explicitly use this middleware and add their action/connection permissions.

Logout returns `{"data":{"message":"Logged out."},"requestId":"..."}`.
It deletes the supplied session before clearing the cookie, using the same cookie
path/security options without Max-Age. Repeated logout, or logout with no valid
cookie, succeeds. Logout is POST only; GET does not change session state.

### Browser protection and login limits

Login/logout require an exact Origin match in `API_CORS_ORIGINS`. Missing or null
Origin is rejected, even for non-browser tools; supply the allowed frontend Origin
explicitly in Postman/curl. This is a browser request-forgery safeguard, not proof
of identity: non-browser clients can set Origin themselves and still need valid
credentials. No Origin is inferred from untrusted Host or forwarding headers.
SameSite=Lax, JSON-only bodies and exact credentialed CORS are additional controls.
This supports same-site frontend/API deployment; cross-site cookie deployment is
not supported by this configuration. Trusted frontend origins must be controlled.

The login limiter defaults to 10 attempts per client IP in a 15-minute window.
Both successful and unsuccessful attempts reaching the login limiter count.
The next request returns 429 `LOGIN_RATE_LIMIT_EXCEEDED` with Retry-After, before
password verification. Configurable maximums are 1000 attempts and a one-hour
window. The global API limiter also remains active. Counters are in memory and
reset on restart; clients behind a shared IP/proxy share a limit. No trust-proxy
change or per-user lockout is introduced in this phase.

### Frontend example

Configure the actual frontend origin before starting the API:

```powershell
$env:API_CORS_ORIGINS = "http://localhost:5173"
npm run api
```

From that frontend, using an intentionally provisioned account:

```javascript
const response = await fetch("http://localhost:3081/api/v1/auth/login", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const result = await response.json();
// Check response.ok; browsers set Origin and store the HttpOnly cookie themselves.

await fetch("http://localhost:3081/api/v1/auth/me", { credentials: "include" });
await fetch("http://localhost:3081/api/v1/auth/logout", {
  method: "POST",
  credentials: "include",
});
```

Do not store a session token in frontend localStorage. For HTTPS deployments,
use Secure cookies and ensure the browser reaches the API through HTTPS. The
current settings server's separate login/session behaviour is unchanged.

## Local setup and Postman walkthrough - phase 3

### Prepare and start the API

1. Run commands from the repository root. The default users and session paths
   are relative to that directory.
2. Have an administrator provision `data/rbac-users.json` with intended accounts
   using the existing `hashPassword()` format. Each API account needs `username`, `email`,
   `role` (`admin` or `viewer`), `passwordSalt` and `passwordHash`. Do not put a
   plain-text password in this file or use the example/default accounts as real
   deployment credentials. There is no registration or user-management endpoint.
3. Restrict access to the users/session files. The API account needs read access
   to the users file and create/write/rename access in the session directory.
4. Configure the actual frontend origin. For local HTTP development, for example:

```powershell
$env:API_CORS_ORIGINS = "http://localhost:5173"
$env:API_AUTH_USERS_FILE = "data/rbac-users.json"
$env:API_SESSION_FILE = "data/api-sessions.json"
$env:API_SESSION_COOKIE_SECURE = "false"
npm run api
```

Use the last setting only for local HTTP development, not production or HTTPS.
The API does not infer cookie security from `NODE_ENV`; set Secure=true explicitly
for HTTPS deployments.
Process environment variables override `.env`; `.env.local` is not loaded.
No real accounts, credentials or environment files are changed by this guide.

### Sign in

In Postman, send `POST http://localhost:3081/api/v1/auth/login` with:

```http
Origin: http://localhost:5173
Content-Type: application/json
```

Choose a raw JSON body and use an existing provisioned account:

```json
{
  "email": "<your configured email>",
  "password": "<that account's password>"
}
```

Expect 200 with `data.user`, `data.expiresAt` and `requestId`. Postman's cookie
jar should retain `connector_api_session` from Set-Cookie. Do not disable its
cookie jar or add a duplicate Cookie header. Do not share cookie values or
passwords in screenshots, saved public requests or logs.

### Read the signed-in user

Send `GET http://localhost:3081/api/v1/auth/me` using the same Postman cookie jar
and hostname. No request body is needed. Expect 200 with the user and expiry.
This endpoint identifies the session; it does not refresh its lifetime.

### Sign out

Send `POST http://localhost:3081/api/v1/auth/logout` with the allowed Origin and
the same cookie jar. Leave the body empty or send `{}`. Expect 200 with
`data.message` equal to `Logged out.` The saved session is removed and the cookie
is cleared. A subsequent `/me` request returns 401. Repeated logout is harmless.

Postman does not enforce browser CORS rules. A working Postman flow is not proof
that React's browser integration is configured correctly. React must use
`credentials: "include"`; the backend must allow its exact Origin. Browser
cookie rules, Secure and SameSite still apply.

## Troubleshooting

| Symptom | Meaning and next step |
| --- | --- |
| API fails before listening with a local-auth configuration error | Check the users-file path, permissions, JSON array, supported roles and generated password hashes. The API will not create example users. |
| Startup reports invalid session JSON | Stop the API and inspect the file locally. Restore a valid file, or deliberately remove it to invalidate all sessions. Do not edit it while the API is running. |
| Login returns 400 | Send only email/password as strings within the documented limits; do not send username, role or token. |
| Login returns 401 | The email/password did not match. Check that the account has an email configured. The response intentionally does not reveal which value was wrong. |
| Login/logout returns 403 | Send the exact allowed Origin. Missing Origin is rejected even in Postman. Check for port differences or a trailing slash in configuration. |
| Login succeeds but `/me` returns 401 | Check cookie storage, expiry, `credentials: "include"`, hostname and Secure settings. Do not mix localhost and 127.0.0.1 or send duplicate cookies. |
| Login returns 429 | Wait for Retry-After. The login allowance is shared by callers with the same apparent IP; both successful and failed attempts count. |
| Login returns 503 | The configured users file could not be loaded or validated after startup. Fix it; this is not a wrong-password response. |
| An auth request returns 500 | Use requestId to find the correlated error log. Inspect session-file validity, disk space and directory permissions locally. Raw file contents/errors are deliberately not returned to clients. |
| Logout returns 500 | Session removal may have failed. Do not treat the user as securely logged out merely by clearing frontend state; fix storage and retry logout. |
| Frontend reports CORS failure | Check its exact Origin, credentialed fetch and preflight response. A browser can hide a response even when the API processed the request. |
| Users stay logged in after restart | Expected: unexpired sessions persist in the file. Restart is not session revocation. |

The default log is intentionally minimal and may not contain a detailed file
failure cause. Use controlled local diagnosis; do not add passwords, cookies or
file contents to shared logs to troubleshoot it.

## Phase-3 verification and handoff

On 2026-11-12, 137 temporary checks passed against this implementation:

- 89 HTTP/session checks covering successful and failed login, input/Origin
  validation, CORS response headers, cookie attributes, `/me`, logout, token
  replacement, persistence, expiry, login/global limits, failed writes, corrupted
  files and secret-free response/log handling.
- 48 account/configuration/startup/shutdown checks covering missing or invalid
  account files, no automatic account creation/migration, invalid session files,
  configuration bounds, cookie settings, port conflicts and shutdown.

After that verification, cookie configuration was decoupled from `NODE_ENV`.
Focused checks confirmed that the default is false regardless of environment,
explicit true/false values are respected, and invalid values still fail validation.

These were temporary inline checks using synthetic accounts and temporary session
data, not committed test files or a maintained automated test suite. Temporary data
was removed. Startup/shutdown was exercised in-process; separate-process launching
was unavailable in the verification environment. HTTP checks do not simulate browser
cookie/CORS enforcement. Complete a browser check with the actual React origin,
HTTPS/proxy configuration and deployment permissions before release.

This completes the three-phase local authentication API scope, not a production
security certification or a performance benchmark. The remaining boundaries are:

- One API process/store per session file; no multi-process coordination.
- No maximum session count; full-file reads/writes are intended for small deployments.
- Rate-limit counters are process-local and proxy trust is not configured yet.
- Existing sessions retain login-time roles and permissions; account changes need deliberate session
  invalidation (stop API, remove session file, restart).
- No Entra/SSO, MFA, password reset, user-management API or instant per-user revocation.
- Future extraction/connection endpoints must explicitly apply authentication and
  action/connection authorization; adding these login routes does not protect them.
- No live connector, production browser, load, container or power-loss validation
  was performed in this phase.
