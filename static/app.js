// nao-query — frontend
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let cm;
let currentResult = null;

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toast-mount").appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ---------- Connections ----------
async function loadConnections() {
  const data = await api("/api/connections");
  const sel = $("#conn-select");
  sel.innerHTML = "";
  if (!data.connections.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— no connections yet —";
    sel.appendChild(opt);
    $("#conn-meta").textContent = "";
    return;
  }
  data.connections.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name} — ${c.database}@${c.host}`;
    if (c.id === data.active_id) opt.selected = true;
    sel.appendChild(opt);
  });
  const active = data.connections.find((c) => c.id === data.active_id);
  if (active) $("#conn-meta").textContent = `${active.user}@${active.host}:${active.port}/${active.database}`;
}

$("#conn-select").addEventListener("change", async (e) => {
  await api("/api/connections/active", { method: "POST", body: JSON.stringify({ id: e.target.value }) });
  loadConnections();
});

// ---------- Modal (manage connections) ----------
$("#btn-manage").addEventListener("click", () => openModal());
$("#btn-close").addEventListener("click", () => closeModal());
$("#btn-new-connection").addEventListener("click", () => {
  resetForm();
  $("#f-name").focus();
});

async function openModal() {
  $("#modal").classList.add("open");
  await renderConnList();
  resetForm();
}
function closeModal() { $("#modal").classList.remove("open"); }

async function renderConnList() {
  const data = await api("/api/connections");
  const host = $("#conn-list");
  host.innerHTML = "";
  if (!data.connections.length) {
    host.innerHTML = '<div class="empty-state" style="padding:12px">No connections yet.</div>';
    return;
  }
  data.connections.forEach((c) => {
    const row = document.createElement("div");
    row.className = "conn" + (c.id === data.active_id ? " active" : "");
    row.innerHTML = `<div><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.user)}@${escapeHtml(c.host)}:${c.port}/${escapeHtml(c.database)}</small></div>`;
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => fillForm(c);

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.onclick = async () => {
      if (!confirm(`Delete connection "${c.name}"?`)) return;
      await api(`/api/connections/${c.id}`, { method: "DELETE" });
      await renderConnList();
      await loadConnections();
    };

    actions.append(editBtn, delBtn);
    row.appendChild(actions);
    host.appendChild(row);
  });
}

function fillForm(c) {
  $("#f-id").value = c.id || "";
  $("#f-name").value = c.name || "";
  $("#f-host").value = c.host || "";
  $("#f-port").value = c.port || 5432;
  $("#f-database").value = c.database || "";
  $("#f-user").value = c.user || "";
  $("#f-password").value = "";
  $("#f-sslmode").value = c.sslmode || "prefer";
}
function resetForm() { fillForm({ port: 5432, sslmode: "prefer" }); }

$("#conn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    id: $("#f-id").value || undefined,
    name: $("#f-name").value,
    host: $("#f-host").value,
    port: $("#f-port").value,
    database: $("#f-database").value,
    user: $("#f-user").value,
    password: $("#f-password").value,
    sslmode: $("#f-sslmode").value,
  };
  try {
    await api("/api/connections", { method: "POST", body: JSON.stringify(body) });
    toast("Saved");
    await renderConnList();
    await loadConnections();
    resetForm();
  } catch (err) { toast(err.message, "err"); }
});

$("#btn-test").addEventListener("click", async () => {
  // Save first (so creds exist server-side), then ping.
  const body = {
    id: $("#f-id").value || undefined,
    name: $("#f-name").value || "Test",
    host: $("#f-host").value,
    port: $("#f-port").value,
    database: $("#f-database").value,
    user: $("#f-user").value,
    password: $("#f-password").value,
    sslmode: $("#f-sslmode").value,
  };
  try {
    const save = await api("/api/connections", { method: "POST", body: JSON.stringify(body) });
    $("#f-id").value = save.id;
    const res = await api(`/api/connections/${save.id}/test`, { method: "POST" });
    toast(res.ok ? "Connection OK" : "Failed", res.ok ? "ok" : "err");
    await loadConnections();
    await renderConnList();
  } catch (err) { toast(err.message, "err"); }
});

// ---------- Editor ----------
window.addEventListener("load", async () => {
  cm = CodeMirror.fromTextArea($("#editor"), {
    mode: "text/x-sql",
    theme: "material-darker",
    lineNumbers: true,
    lineWrapping: true,
    indentWithTabs: false,
    indentUnit: 2,
    extraKeys: {
      Enter: runQuery,
      "Shift-Enter": (cm) => cm.replaceSelection("\n"),
      "Cmd-Enter": runQuery,
      "Ctrl-Enter": runQuery,
      Tab: (cm) => cm.replaceSelection("  "),
    },
  });
  cm.setValue("-- welcome. cmd+enter to run.\nSELECT NOW();\n");
  await loadConnections();
  await loadHistory();
});

// ---------- Query runner ----------
async function runQuery() {
  const sql = cm.getValue().trim();
  if (!sql) return;
  const connName = $("#conn-select").selectedOptions[0]?.textContent?.split(" — ")[0] || "";
  $("#status").textContent = "Running…";
  $("#status").className = "status";
  $("#btn-copy").disabled = true;
  $("#btn-copy-json-packet").disabled = true;
  $("#btn-copy-csv").disabled = true;

  try {
    const data = await api("/api/query", {
      method: "POST",
      body: JSON.stringify({ sql, connection_id: $("#conn-select").value || undefined }),
    });
    currentResult = { ...data, sql };
    renderResults(data);
    const stmtCount = data.statement_count || (data.results ? data.results.length : 1);
    const stmtLabel = stmtCount > 1 ? `${stmtCount} stmts · ` : "";
    $("#status").textContent = `${stmtLabel}${data.rowcount} row(s) · ${data.elapsed_ms}ms · ${data.connection_name || ""}`;
    $("#status").className = data.ok ? "status ok" : "status err";
    $("#btn-copy").disabled = false;
    $("#btn-copy-json-packet").disabled = false;
    $("#btn-copy-csv").disabled = !data.results || data.results.every((r) => !r.columns?.length);
  } catch (err) {
    // Keep the error on currentResult so copy works for errors too.
    currentResult = {
      sql,
      error: err.message,
      connection_name: connName,
      columns: [],
      rows: [],
      rowcount: 0,
      elapsed_ms: 0,
    };
    $("#results-body").innerHTML = `<div class="empty-state" style="color:var(--danger);text-align:left;white-space:pre-wrap;font-family:SF Mono, Menlo, Consolas, monospace;font-size:12.5px">${escapeHtml(err.message)}</div>`;
    $("#status").textContent = `Error — ${err.message}`;
    $("#status").className = "status err";
    $("#btn-copy").disabled = false;
    $("#btn-copy-json-packet").disabled = false;
    $("#btn-copy-csv").disabled = true;
  }
  loadHistory();
}

$("#btn-run").addEventListener("click", runQuery);
$("#btn-clear").addEventListener("click", () => { cm.setValue(""); cm.focus(); });
$("#btn-paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return toast("Clipboard is empty", "err");
    cm.setValue(text);
    cm.focus();
    cm.setCursor(cm.lineCount(), 0);
  } catch (err) { toast("Paste failed: " + err.message, "err"); }
});

// Postgres type OID → friendly label (subset of common ones)
const PG_TYPES = {
  16: "bool", 17: "bytea", 20: "int8", 21: "int2", 23: "int4",
  25: "text", 700: "float4", 701: "float8", 1042: "char", 1043: "varchar",
  1082: "date", 1114: "timestamp", 1184: "timestamptz", 1186: "interval",
  1700: "numeric", 114: "json", 3802: "jsonb", 2950: "uuid",
};

function renderOneResultTable(r) {
  if (!r.ok) {
    return `<div class="empty-state" style="color:var(--danger);text-align:left;white-space:pre-wrap;font-family:SF Mono, Menlo, Consolas, monospace;font-size:12.5px;padding:12px">${escapeHtml(r.error || "Error")}</div>`;
  }
  if (!r.columns.length) {
    return `<div class="empty-state">${r.message || "OK"} — ${r.rowcount} row(s) affected</div>`;
  }
  if (!r.rows.length) {
    return '<div class="empty-state">0 rows returned.</div>';
  }
  const longCols = new Set();
  r.rows.forEach((row) => {
    r.columns.forEach((c) => {
      const v = row[c.name];
      if (typeof v === "string" && v.length > 60) longCols.add(c.name);
      if (typeof v === "object" && v !== null) longCols.add(c.name);
    });
  });

  let html = "<table><thead><tr>";
  html += `<th class="rownum">#</th>`;
  r.columns.forEach((c) => {
    const t = PG_TYPES[c.type_code] || "";
    html += `<th>${escapeHtml(c.name)}${t ? `<span class="type">${t}</span>` : ""}</th>`;
  });
  html += "</tr></thead><tbody>";
  r.rows.forEach((row, i) => {
    html += `<tr><td class="rownum">${i + 1}</td>`;
    r.columns.forEach((c) => {
      const v = row[c.name];
      const wrap = longCols.has(c.name) ? " wrap" : "";
      if (v === null || v === undefined) {
        html += `<td${wrap ? ' class="wrap"' : ""}><span class="null">NULL</span></td>`;
      } else if (typeof v === "number") {
        html += `<td class="num${wrap}">${escapeHtml(String(v))}</td>`;
      } else if (typeof v === "boolean") {
        html += `<td class="bool${wrap}">${v ? "true" : "false"}</td>`;
      } else if (typeof v === "object") {
        html += `<td class="wrap">${escapeHtml(JSON.stringify(v, null, 2))}</td>`;
      } else {
        html += `<td${wrap ? ' class="wrap"' : ""}>${escapeHtml(String(v))}</td>`;
      }
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  return html;
}

function renderResults(data) {
  const body = $("#results-body");
  // New format — array of results
  const results = data.results || [];
  if (!results.length) {
    if (data.connection_error) {
      body.innerHTML = `<div class="empty-state" style="color:var(--danger)">${escapeHtml(data.connection_error)}</div>`;
    } else {
      body.innerHTML = '<div class="empty-state">No results.</div>';
    }
    return;
  }

  // Single result — render flat (no header block) for back-compat feel
  if (results.length === 1) {
    body.innerHTML = renderOneResultTable(results[0]);
    return;
  }

  // Multiple results — each gets a header + its own table
  body.innerHTML = "";
  results.forEach((r, idx) => {
    const block = document.createElement("div");
    block.style.cssText = "border-bottom: 2px solid var(--border);";

    const header = document.createElement("div");
    header.style.cssText = "padding: 8px 12px; background: var(--panel-2); font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px;";
    const sqlLines = (r.sql || "").split("\n").filter((l) => l.trim());
    const sqlPreview = sqlLines[0] ? sqlLines[0].slice(0, 100) + (sqlLines[0].length > 100 ? "…" : "") : "(empty)";
    const statusColor = r.ok ? "var(--ok)" : "var(--danger)";
    const statusText = r.ok ? `${r.rowcount} row(s) · ${r.elapsed_ms}ms` : `Error · ${r.elapsed_ms}ms`;
    header.innerHTML = `<b style="color:var(--accent);">[${idx + 1}/${results.length}]</b> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(sqlPreview)}</span> <span style="color:${statusColor};white-space:nowrap;">${statusText}</span>`;
    block.appendChild(header);

    const tableContainer = document.createElement("div");
    tableContainer.innerHTML = renderOneResultTable(r);
    block.appendChild(tableContainer);

    body.appendChild(block);
  });
}

// ---------- Copy helpers ----------
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.top = "-1000px";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  el.remove();
  if (!ok) throw new Error("clipboard API unavailable");
}

function setCopied(button, label) {
  button.classList.add("copied");
  button.textContent = "Copied ✓";
  setTimeout(() => {
    button.classList.remove("copied");
    button.textContent = label;
  }, 1500);
}

function buildJsonPayload(r) {
  const output = {
    connection: r.connection_name || "unknown",
    sql: r.sql,
    elapsed_ms: r.elapsed_ms,
  };

  if (r.error && !(r.results && r.results.length)) {
    output.error = r.error;
    return output;
  }

  const results = r.results || [];
  if (!results.length) {
    output.results = [];
    return output;
  }

  output.results = results.map((res) => {
    if (!res.ok) {
      return { ok: false, sql: res.sql, error: res.error, elapsed_ms: res.elapsed_ms };
    }
    if (!res.columns || !res.columns.length) {
      return { ok: true, sql: res.sql, affected_rows: res.rowcount, elapsed_ms: res.elapsed_ms };
    }
    return {
      ok: true,
      sql: res.sql,
      columns: res.columns.map((c) => c.name),
      rows: res.rows,
      row_count: res.rowcount,
      elapsed_ms: res.elapsed_ms,
    };
  });

  return output;
}

function resultToCsv(r) {
  if (!r || !r.ok || !r.columns?.length) return "";
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => esc(c.name)).join(",")];
  (r.rows || []).forEach((row) => lines.push(r.columns.map((c) => esc(row[c.name])).join(",")));
  return lines.join("\n");
}

function firstTabularResult(results) {
  const index = results.findIndex((x) => x.ok && x.columns?.length);
  return index === -1 ? { result: null, index: -1 } : { result: results[index], index };
}

function buildJsonCopy(r) {
  const jsonText = JSON.stringify(buildJsonPayload(r), null, 2);
  const results = r.results || [];
  const csvBlocks = results
    .map((res, idx) => ({ res, idx, csv: resultToCsv(res) }))
    .filter((item) => item.csv)
    .map((item) => {
      const label = results.length > 1 ? `Statement ${item.idx + 1} CSV` : "CSV";
      return `${label}:\n\`\`\`csv\n${item.csv}\n\`\`\``;
    });

  return [
    "nao-query result",
    "",
    "JSON:",
    "```json",
    jsonText,
    "```",
    "",
    csvBlocks.length ? csvBlocks.join("\n\n") : "CSV: no tabular result",
  ].join("\n");
}

// ---------- Copy JSON ----------
$("#btn-copy").addEventListener("click", async () => {
  if (!currentResult) return;
  const text = formatJSON(currentResult);
  try {
    await writeClipboard(text);
    setCopied($("#btn-copy"), "Copy JSON");
  } catch (err) { toast("Copy failed: " + err.message, "err"); }
});

$("#btn-copy-json-packet").addEventListener("click", async () => {
  if (!currentResult) return;
  try {
    await writeClipboard(buildJsonCopy(currentResult));
    setCopied($("#btn-copy-json-packet"), "Copy to JSON");
  } catch (err) { toast("Copy failed: " + err.message, "err"); }
});

$("#btn-copy-csv").addEventListener("click", async () => {
  if (!currentResult) return;
  const results = currentResult.results || [];
  const { result, index } = firstTabularResult(results);
  if (!result) {
    toast("No tabular result to copy", "err");
    return;
  }
  try {
    await writeClipboard(resultToCsv(result));
    toast(results.length > 1 ? `CSV copied (statement ${index + 1} of ${results.length})` : "CSV copied");
  } catch (err) { toast("Copy failed: " + err.message, "err"); }
});

function formatJSON(r) {
  return JSON.stringify(buildJsonPayload(r), null, 2);
}

// ---------- History ----------
async function loadHistory() {
  const data = await api("/api/history");
  const host = $("#history-list");
  host.innerHTML = "";
  if (!data.length) {
    host.innerHTML = '<div style="color:var(--muted);padding:8px;font-size:12px">No history.</div>';
    return;
  }
  data.slice(0, 30).forEach((h) => {
    const row = document.createElement("div");
    row.className = "history-item";
    const preview = (h.sql || "").split("\n").find((l) => l.trim()) || "";
    row.title = h.sql;
    row.textContent = (h.ok ? "✓ " : "✗ ") + preview.slice(0, 60);
    row.onclick = () => cm.setValue(h.sql);
    host.appendChild(row);
  });
}
$("#btn-clear-history").addEventListener("click", async () => {
  if (!confirm("Clear all query history?")) return;
  await api("/api/history", { method: "DELETE" });
  loadHistory();
});

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- Heartbeat (keep server alive; auto-terminate on tab close) ----------
// Browser pings every 10s. Server watchdog exits if no ping for 600s (10 min).
// Longer timeout tolerates background-tab throttling (Chrome throttles setInterval
// to ~1/min in hidden tabs). Also ping on visibility-regained for fast recovery.
// On tab close we send a beacon so server exits immediately.
function pingHeartbeat() {
  fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
}
setInterval(pingHeartbeat, 10000);
pingHeartbeat();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pingHeartbeat();
});

function sendShutdownBeacon() {
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/shutdown");
    } else {
      fetch("/api/shutdown", { method: "POST", keepalive: true });
    }
  } catch (e) { /* nothing to do — tab is closing */ }
}
window.addEventListener("pagehide", sendShutdownBeacon);
window.addEventListener("beforeunload", sendShutdownBeacon);
