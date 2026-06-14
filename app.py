"""
nao-query — minimal local Postgres query runner.
Run: python app.py  →  http://localhost:5050
"""
import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path

import psycopg2
import psycopg2.extras
from flask import Flask, jsonify, render_template, request

APP_DIR = Path(__file__).parent
# Config + history live in the user's home dir so creds survive folder moves.
USER_DIR = Path.home() / ".nao-query"
USER_DIR.mkdir(exist_ok=True)
CONFIG_PATH = USER_DIR / "config.json"
HISTORY_PATH = USER_DIR / "history.json"
HISTORY_MAX = 200

# One-time migration from the old in-repo location so existing users don't lose creds.
for old, new in [(APP_DIR / "config.json", CONFIG_PATH), (APP_DIR / "history.json", HISTORY_PATH)]:
    if old.exists() and not new.exists():
        try:
            new.write_text(old.read_text())
            old.unlink()
        except Exception:
            pass

# Heartbeat watchdog — terminate server if browser is gone.
# 10 min gives backgrounded tabs (whose setInterval gets throttled to ~1/min)
# plenty of slack. Browser still sends a beacon on tab close for fast exit.
HEARTBEAT_TIMEOUT_SEC = 600
_last_heartbeat = time.time()
_hb_lock = threading.Lock()


def _bump_heartbeat():
    global _last_heartbeat
    with _hb_lock:
        _last_heartbeat = time.time()


def _watchdog():
    """Exit the process if the browser stops pinging for HEARTBEAT_TIMEOUT_SEC."""
    while True:
        time.sleep(5)
        with _hb_lock:
            idle = time.time() - _last_heartbeat
        if idle > HEARTBEAT_TIMEOUT_SEC:
            # Hard-exit — no graceful shutdown needed, browser is gone.
            os._exit(0)

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # no static caching during dev


# ---------------------------------------------------------------------------
# Config + history persistence (local JSON on disk)
# ---------------------------------------------------------------------------
def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, default=str))


def get_config():
    return load_json(CONFIG_PATH, {"connections": [], "active_id": None})


def save_config(cfg):
    save_json(CONFIG_PATH, cfg)


def get_history():
    return load_json(HISTORY_PATH, [])


def append_history(entry):
    h = get_history()
    h.insert(0, entry)
    save_json(HISTORY_PATH, h[:HISTORY_MAX])


def find_connection(conn_id):
    for c in get_config().get("connections", []):
        if c["id"] == conn_id:
            return c
    return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/connections", methods=["GET"])
def list_connections():
    cfg = get_config()
    # strip passwords on the way out
    safe = [{**c, "password": "••••••" if c.get("password") else ""} for c in cfg["connections"]]
    return jsonify({"connections": safe, "active_id": cfg.get("active_id")})


@app.route("/api/connections", methods=["POST"])
def upsert_connection():
    data = request.get_json(force=True)
    cfg = get_config()

    conn_id = data.get("id") or f"conn_{int(time.time() * 1000)}"
    existing = next((c for c in cfg["connections"] if c["id"] == conn_id), None)

    payload = {
        "id": conn_id,
        "name": data.get("name", "Untitled"),
        "host": data.get("host", ""),
        "port": int(data.get("port") or 5432),
        "database": data.get("database", ""),
        "user": data.get("user", ""),
        "password": data.get("password") if data.get("password") else (existing or {}).get("password", ""),
        "sslmode": data.get("sslmode", "prefer"),
    }

    if existing:
        cfg["connections"] = [payload if c["id"] == conn_id else c for c in cfg["connections"]]
    else:
        cfg["connections"].append(payload)

    if not cfg.get("active_id"):
        cfg["active_id"] = conn_id

    save_config(cfg)
    return jsonify({"ok": True, "id": conn_id})


@app.route("/api/connections/<conn_id>", methods=["DELETE"])
def delete_connection(conn_id):
    cfg = get_config()
    cfg["connections"] = [c for c in cfg["connections"] if c["id"] != conn_id]
    if cfg.get("active_id") == conn_id:
        cfg["active_id"] = cfg["connections"][0]["id"] if cfg["connections"] else None
    save_config(cfg)
    return jsonify({"ok": True})


@app.route("/api/connections/active", methods=["POST"])
def set_active():
    data = request.get_json(force=True)
    cfg = get_config()
    cfg["active_id"] = data.get("id")
    save_config(cfg)
    return jsonify({"ok": True})


@app.route("/api/connections/<conn_id>/test", methods=["POST"])
def test_connection(conn_id):
    c = find_connection(conn_id)
    if not c:
        return jsonify({"ok": False, "error": "connection not found"}), 404
    try:
        with psycopg2.connect(
            host=c["host"], port=c["port"], dbname=c["database"],
            user=c["user"], password=c["password"], sslmode=c.get("sslmode", "prefer"),
            connect_timeout=5,
        ) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


def split_sql_statements(sql):
    """Split SQL into statements at top-level semicolons.
    Skips ; inside string literals ('...', "..."), line comments (-- to EOL),
    and block comments (/* ... */). Does NOT handle PostgreSQL dollar-quoted
    strings ($tag$...$tag$) — uncommon in our use case.
    Returns a list of trimmed non-empty statements (without trailing ;)."""
    statements = []
    current = []
    i = 0
    n = len(sql)
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_line_comment:
            current.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            current.append(ch)
            if ch == "*" and nxt == "/":
                current.append(nxt)
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_single:
            current.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            current.append(ch)
            if ch == '"':
                in_double = False
            i += 1
            continue
        if ch == "-" and nxt == "-":
            current.append(ch)
            in_line_comment = True
            i += 1
            continue
        if ch == "/" and nxt == "*":
            current.append(ch)
            in_block_comment = True
            i += 1
            continue
        if ch == "'":
            current.append(ch)
            in_single = True
            i += 1
            continue
        if ch == '"':
            current.append(ch)
            in_double = True
            i += 1
            continue
        if ch == ";":
            stmt = "".join(current).strip()
            if stmt:
                statements.append(stmt)
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    stmt = "".join(current).strip()
    if stmt:
        statements.append(stmt)
    return statements


def _normalize_row_values(row):
    for k, v in list(row.items()):
        if isinstance(v, (datetime,)):
            row[k] = v.isoformat()
        elif v is not None and not isinstance(v, (str, int, float, bool, list, dict)):
            row[k] = str(v)
    return row


@app.route("/api/query", methods=["POST"])
def run_query():
    data = request.get_json(force=True)
    sql = (data.get("sql") or "").strip()
    conn_id = data.get("connection_id") or get_config().get("active_id")

    if not sql:
        return jsonify({"ok": False, "error": "empty query"}), 400

    c = find_connection(conn_id)
    if not c:
        return jsonify({"ok": False, "error": "no active connection — add one in Settings"}), 400

    statements = split_sql_statements(sql)
    if not statements:
        return jsonify({"ok": False, "error": "no executable statements found"}), 400

    started = time.time()
    results = []
    connection_error = None

    try:
        with psycopg2.connect(
            host=c["host"], port=c["port"], dbname=c["database"],
            user=c["user"], password=c["password"], sslmode=c.get("sslmode", "prefer"),
            connect_timeout=10,
        ) as conn:
            # autocommit so each statement is isolated — an error in one doesn't poison the rest.
            conn.autocommit = True
            for stmt in statements:
                stmt_started = time.time()
                try:
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                        cur.execute(stmt)
                        if cur.description:
                            columns = [
                                {"name": d.name, "type_code": d.type_code}
                                for d in cur.description
                            ]
                            rows = [_normalize_row_values(dict(r)) for r in cur.fetchall()]
                            results.append({
                                "ok": True,
                                "sql": stmt,
                                "columns": columns,
                                "rows": rows,
                                "rowcount": len(rows),
                                "elapsed_ms": int((time.time() - stmt_started) * 1000),
                            })
                        else:
                            results.append({
                                "ok": True,
                                "sql": stmt,
                                "columns": [],
                                "rows": [],
                                "rowcount": cur.rowcount,
                                "message": "OK",
                                "elapsed_ms": int((time.time() - stmt_started) * 1000),
                            })
                except Exception as stmt_err:
                    results.append({
                        "ok": False,
                        "sql": stmt,
                        "columns": [],
                        "rows": [],
                        "rowcount": 0,
                        "error": str(stmt_err),
                        "elapsed_ms": int((time.time() - stmt_started) * 1000),
                    })
                    # continue to next statement — autocommit means the connection isn't poisoned
    except Exception as conn_err:
        connection_error = str(conn_err)

    elapsed_ms = int((time.time() - started) * 1000)
    total_rowcount = sum((r.get("rowcount") or 0) for r in results if r.get("ok"))
    all_ok = (not connection_error) and all(r["ok"] for r in results) and bool(results)

    append_history({
        "ts": datetime.utcnow().isoformat() + "Z",
        "connection_id": conn_id,
        "connection_name": c["name"],
        "sql": sql,
        "rowcount": total_rowcount,
        "elapsed_ms": elapsed_ms,
        "ok": all_ok,
        "statement_count": len(statements),
        "error": connection_error,
    })

    if connection_error and not results:
        return jsonify({
            "ok": False,
            "error": connection_error,
            "elapsed_ms": elapsed_ms,
            "connection_name": c["name"],
        }), 400

    return jsonify({
        "ok": all_ok,
        "results": results,
        "elapsed_ms": elapsed_ms,
        "connection_name": c["name"],
        "rowcount": total_rowcount,
        "statement_count": len(statements),
        "connection_error": connection_error,
    })


@app.route("/api/history", methods=["GET"])
def history():
    return jsonify(get_history())


@app.route("/api/history", methods=["DELETE"])
def clear_history():
    save_json(HISTORY_PATH, [])
    return jsonify({"ok": True})


@app.route("/api/heartbeat", methods=["POST", "GET"])
def heartbeat():
    _bump_heartbeat()
    return jsonify({"ok": True})


@app.route("/api/shutdown", methods=["POST", "GET"])
def shutdown():
    """Called on browser tab close via sendBeacon — exits almost immediately."""
    def _exit_soon():
        time.sleep(0.2)
        os._exit(0)
    threading.Thread(target=_exit_soon, daemon=True).start()
    return jsonify({"ok": True})


if __name__ == "__main__":
    # Bump once on boot so the watchdog doesn't immediately kill us before the browser connects.
    _bump_heartbeat()
    threading.Thread(target=_watchdog, daemon=True).start()
    print("nao-query running → http://localhost:5050")
    app.run(host="127.0.0.1", port=5050, debug=False)
