# QA: all connectors in one container

This image is the current monolith. Slack, Postgres, Oracle, SharePoint, Salesforce, Jira, Google Drive, Box, and Confluence are the same Node process. One container per connector is the later platform layout, not this QA package.

Secrets stay in `.env` on the QA machine. The image build does not copy `.env`. Compose injects those variables when the container starts.

## 1. Install Docker on the VM

Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in, then `docker version`.

## 2. Run

From the project directory, with a filled `.env`:

```bash
docker compose build
docker compose run --rm connectors npm run test:jira
docker compose run --rm connectors npm run extract:jira
```

Replace `jira` with `slack`, `postgres`, `oracle`, `sharepoint`, `salesforce`, `googledrive`, `box`, or `confluence`.

JSONL files appear on the host at `data/output/<connector>/`.

## 3. What QA needs besides the image

| Connector | Must be reachable from the VM |
|---|---|
| Slack | Slack API, bot token in `.env` |
| Postgres | Database host and port (for example Aiven) |
| Oracle | Oracle listener, or an Oracle Free container on the same Docker network |
| SharePoint | Microsoft Graph, app credentials |
| Salesforce | Salesforce login, token or connected-app secret |
| Jira / Confluence | `https://<site>.atlassian.net`, email + API token |
| Google Drive | Service-account file under `certs/` (mounted read-only) or OAuth refresh token |
| Box | Developer token or client credentials |

A connector whose credentials are empty fails its own test. The others still run.
