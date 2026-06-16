# nao-query

Minimal local Postgres query runner with a web UI. Multi-connection support, one-click "Copy JSON" to grab results as structured JSON, and "Copy to JSON" to grab a JSON + CSV packet.

## Setup

```bash
cd tools/nao-query
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:5050

## First run

1. Click **Connections** (top bar)
2. Fill in your Postgres connection details
3. Click **Test** → should say "Connection OK"
4. Click **Save**

## Running queries

- Type SQL in the editor
- `Cmd+Enter` (or click **Run**) to execute
- Click **Copy JSON** → copies query + result as structured JSON
- Click **Copy to JSON** → copies structured JSON plus CSV blocks for tabular results

## Features

- **Multi-statement queries** — run multiple SQL statements separated by `;`, each rendered independently
- **Copy JSON** — copies the query and results as a clean JSON object (SQL, columns, rows, metadata)
- **Copy to JSON** — copies the JSON packet and CSV derived from the same result data, so downstream tools can use either format
- **Copy CSV** — copies the first result as CSV
- **Connection management** — save, edit, test, and switch between connections
- **Query history** — last 200 queries, click to restore
- **Auto-shutdown** — closes when you close the browser tab

## Files

Saved state lives in `~/.nao-query/` (persists across repo moves):

- `~/.nao-query/config.json` — saved connections (plaintext, local only)
- `~/.nao-query/history.json` — last 200 queries

## Lifecycle

- Browser sends a heartbeat every 10s, plus an extra ping immediately on tab refocus (`visibilitychange`).
- Closing the browser tab sends a shutdown beacon — server exits immediately.
- If the browser is killed / crashes with no beacon, the watchdog terminates
  the server after **10 minutes** of no heartbeat.
- So you never have to worry about leaving it running in the background.
