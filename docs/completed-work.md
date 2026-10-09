# Data Connector POC — completed work

One Node.js app extracts from 11 sources through the same command line. Each source can be tested, written to JSONL files, or saved to MongoDB. QA can run the same commands from one Docker image.

## Connectors

| Source | What is extracted |
|---|---|
| Slack | Workspace, users, channels, messages, threads, reactions, file metadata |
| PostgreSQL, MySQL, Oracle | Catalog only: schemas, tables, views, columns |
| SharePoint | Site, list, column, and file metadata. File bytes are not downloaded |
| Salesforce | Object definitions, fields, and records |
| Jira | Projects, issues, users, statuses, issue types |
| Google Drive | Drive, folder, file, and permission metadata. File bytes are not downloaded |
| Box | Users, folders, files, and collaborations. File bytes are not downloaded |
| Confluence | Spaces, pages, blog posts, attachment metadata |
| Windows | One shared folder and the files inside it. Files of 5 MB or less can be copied locally |

Each connector has `npm run test:<name>` and `npm run extract:<name>`. JSONL output goes to `data/output/<connector>/`.

## MongoDB

`npm run extract:<name>:mongo` writes into the database named in `MONGO_URL`. Each connector has its own collection (`slack`, `jira`, `postgres`, and so on).

Two shared collections record the run:

- `extraction_runs` — one row per run, with status and a `runId`
- `extraction_checkpoints` — written only after a successful run, for objects that opt in

Slack messages opt in. A successful Slack run stores `lastSuccessfulAt` and `runId` on the messages checkpoint.

## Pagination, checkpoint, and incremental mode

Source APIs are read in pages for Slack, Jira, Confluence, SharePoint, Box, Google Drive, and Salesforce. PostgreSQL, MySQL, and Oracle return the catalog in one query. Windows walks one folder up to a file limit. A page is not saved as a resume point, so a failed run starts that object again.

The checkpoint collection is in place. After a successful run it stores `lastSuccessfulAt` and `runId` for each object that opts in.

Incremental mode is working for the objects that have a modified or created time:

- Slack messages, and Slack files by created time
- Jira issues
- Salesforce records
- Google Drive files and folders
- Confluence pages, blog posts, and attachments
- SharePoint list items and drive items
- Box files and folders
- Windows files

Run a full `extract:<name>:mongo` once, then `npm run extract:<name>:mongo:incremental`. Catalog objects stay a full read: database schemas and columns, Slack users and channels, Jira projects and statuses, Salesforce object definitions, and SharePoint lists and columns.

## Slack incremental extract

`npm run extract:slack:mongo` reads the history window and, on success, saves the checkpoint.

`npm run extract:slack:mongo:incremental` reads only messages posted after that checkpoint and before the new run starts. It needs one successful full run first. A failed run does not move the checkpoint.

The 1,000-message sample (`npm run bench:slack:mongo`) loads demo pages into the `slack` collection. It does not write a checkpoint.

## Delivery and secrets

- One Docker image runs every connector. `.env` stays on the host and is not baked into the image.
- `npm run env:encrypt` and `npm run env:decrypt` protect a copy of `.env`. The app still reads the plaintext file at run time.
- Windows SMB login uses Node’s legacy OpenSSL provider because the SMB library still needs an older cipher.

## Not in this build

Connector registration, a message queue, change detection by hash, and resume from the middle of a failed run are not part of this POC. The Windows connector reads one shared folder, not a whole machine or an admin share.
