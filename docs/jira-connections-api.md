# Jira connections API

Backend for registering a Jira connection (email + API token) so the React UI can replace the mock wizard in `src/ui`.

Run the settings server:

```bash
npm run settings
# http://localhost:3080
```

For a separate React app on another origin, set:

```bash
SETTINGS_CORS_ORIGIN=http://localhost:5173
```

Credentials are stored under `data/connections/<id>.json` (gitignored). API responses never return `apiToken`.

## Auth

1. `POST /api/login` with `{ "username": "admin", "password": "admin123" }`
2. Send the `settings_session` cookie on later requests (`credentials: "include"` in fetch)

Demo users: `admin` / `admin123` (edit + extract), `viewer` / `viewer123` (extract only).

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/connections/meta` | any logged-in | Supported connectors + Jira field schema |
| GET | `/api/connections?connector=jira` | any logged-in | List connections (secrets redacted) |
| POST | `/api/connections` | admin | Register connection |
| GET | `/api/connections/:id` | any logged-in | Get one |
| PATCH | `/api/connections/:id` | admin | Update (token optional) |
| DELETE | `/api/connections/:id` | admin | Delete |
| POST | `/api/connections/:id/test` | admin | Call Jira `/myself` |
| POST | `/api/connections/:id/extract` | viewer/admin | Start extract using this connection |
| GET | `/api/extractions/:request_id` | any logged-in | Poll extract job |

### Register Jira

```http
POST /api/connections
Content-Type: application/json

{
  "connector": "jira",
  "name": "Jira · Engineering",
  "baseUrl": "https://your-team.atlassian.net",
  "email": "you@company.com",
  "apiToken": "atlassian-api-token",
  "authType": "api_token",
  "objects": ["projects", "issues", "users", "statuses", "issueTypes"]
}
```

Aliases accepted: `endpoint` → `baseUrl`, `account` → `email`, `secret` → `apiToken`.

**201 response (no token):**

```json
{
  "id": "…",
  "connector": "jira",
  "name": "Jira · Engineering",
  "baseUrl": "https://your-team.atlassian.net",
  "email": "you@company.com",
  "authType": "api_token",
  "objects": ["projects", "issues", "users", "statuses", "issueTypes"],
  "status": "connected",
  "hasSecret": true,
  "lastTestAt": null,
  "lastTestOk": null,
  "createdAt": "…",
  "updatedAt": "…",
  "createdBy": "admin"
}
```

### Test

```http
POST /api/connections/:id/test
→ 200 { "ok": true, "result": { "ok": true, "accountId": "…", … } }
```

### Extract

```http
POST /api/connections/:id/extract
Content-Type: application/json

{ "mode": "full", "target": "mongo", "objects": ["issues"] }
```

Omit `objects` to use the connection’s saved object list. Poll `GET /api/extractions/:request_id`.

## Notes for React

- Map UI wizard “Application URL” → `baseUrl`, account email → `email`, API token → `apiToken`.
- OAuth is not implemented yet; use `authType: "api_token"`.
- Field mappings still live in `src/config/connectors/jira.json`; the connection only stores credentials + selected objects.
- CLI / `.env` (`JIRA_*`) still works for non-UI extracts; registered connections are independent.
