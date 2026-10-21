-- Phase 2 system of record for extraction jobs (Kafka workers update via status-writer).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS connectors (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  image TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  default_concurrency INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extraction_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  connector_key TEXT NOT NULL REFERENCES connectors (key),
  objects JSONB NOT NULL DEFAULT '[]'::jsonb,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'incremental')),
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS extraction_requests_tenant_status_idx
  ON extraction_requests (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS extraction_requests_connector_idx
  ON extraction_requests (connector_key, created_at DESC);

CREATE TABLE IF NOT EXISTS extraction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES extraction_requests (id) ON DELETE CASCADE,
  attempt INT NOT NULL DEFAULT 1,
  worker_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  UNIQUE (request_id, attempt)
);

CREATE TABLE IF NOT EXISTS extraction_objects (
  request_id UUID NOT NULL REFERENCES extraction_requests (id) ON DELETE CASCADE,
  object TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  records_written BIGINT NOT NULL DEFAULT 0,
  checkpoint JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, object)
);

CREATE TABLE IF NOT EXISTS output_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES extraction_requests (id) ON DELETE CASCADE,
  object TEXT NOT NULL,
  uri TEXT NOT NULL,
  bytes BIGINT,
  record_count BIGINT,
  content_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, object, uri)
);

INSERT INTO connectors (key, display_name, image, enabled) VALUES
  ('slack', 'Slack', 'phase2-worker:latest', TRUE),
  ('postgres', 'PostgreSQL', 'phase2-worker:latest', TRUE),
  ('mysql', 'MySQL', 'phase2-worker:latest', TRUE),
  ('mssql', 'SQL Server', 'phase2-worker:latest', TRUE),
  ('oracle', 'Oracle', 'phase2-worker:latest', TRUE),
  ('sharepoint', 'SharePoint', 'phase2-worker:latest', TRUE),
  ('onedrive', 'OneDrive', 'phase2-worker:latest', TRUE),
  ('salesforce', 'Salesforce', 'phase2-worker:latest', TRUE),
  ('jira', 'Jira', 'phase2-worker:latest', TRUE),
  ('googledrive', 'Google Drive', 'phase2-worker:latest', TRUE),
  ('box', 'Box', 'phase2-worker:latest', TRUE),
  ('confluence', 'Confluence', 'phase2-worker:latest', TRUE),
  ('windows', 'Windows folder', 'phase2-worker:latest', TRUE),
  ('servicenow', 'ServiceNow', 'phase2-worker:latest', TRUE)
ON CONFLICT (key) DO NOTHING;
