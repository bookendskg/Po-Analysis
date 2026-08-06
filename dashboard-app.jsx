const { useState, useMemo, useRef } = React;

// Matches the CLI in fetch-petpooja.mjs — the API caps pages at 50 records and
// rejects date windows longer than a month.
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
const DELAY_MS = 400;
const MAX_WINDOW_DAYS = 30;
const MAX_TABLE_ROWS = 500;

const labelStyle = {
  display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted-color, #555)",
  marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em",
};

const inputStyle = {
  width: "100%", padding: "9px 10px", fontSize: 14,
  border: "1px solid var(--border-color, #ddd)", borderRadius: 6,
  background: "var(--input-bg, #fff)", color: "var(--text-color, #1a1a1a)",
  boxSizing: "border-box",
};

/* ---------- dates ---------- */

// Woken in slices so Cancel takes effect within ~100ms instead of waiting out
// the full throttle delay.
async function sleep(ms, isCancelled) {
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    if (isCancelled && isCancelled()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}

const parseDmy = (s) => {
  const [d, m, y] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const toDmy = (dt) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
};

const isoToDmy = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

// en-CA formats as YYYY-MM-DD in local time. toISOString() would be UTC, which
// reports the previous day for IST users before 05:30.
const todayStr = () => new Date().toLocaleDateString("en-CA");

// Split a range into windows the API will accept (rejects > 1 month, code 101).
function dateWindows(start, end, days = MAX_WINDOW_DAYS) {
  const last = parseDmy(end);
  const windows = [];
  let cursor = parseDmy(start);

  while (cursor <= last) {
    const stop = new Date(cursor.getTime() + (days - 1) * 86400000);
    const to = stop > last ? last : stop;
    windows.push([toDmy(cursor), toDmy(to)]);
    cursor = new Date(to.getTime() + 86400000);
  }
  return windows;
}

// Orders accepts a single date only, so a range becomes one call per day.
function isoDays(startIso, endIso) {
  const out = [];
  let cursor = new Date(startIso + "T00:00:00Z");
  const last = new Date(endIso + "T00:00:00Z");
  while (cursor <= last && out.length < 400) {
    out.push(cursor.toISOString().split("T")[0]);
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return out;
}

// One "unit" is one API call's worth of date parameters.
function unitsFor(apiType, startIso, endIso) {
  if (apiType === "orders") {
    return isoDays(startIso, endIso).map((d) => ({ label: d, params: { order_date: d } }));
  }
  return dateWindows(isoToDmy(startIso), isoToDmy(endIso)).map(([from, to]) => ({
    label: from === to ? from : `${from} → ${to}`,
    params: { from_date: from, to_date: to },
  }));
}

/* ---------- records ---------- */

// Record arrays are named differently per endpoint (purchases / order_json /
// transfers), so take the largest array rather than hardcoding key names.
function summarize(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  let best = null;
  for (const [key, val] of Object.entries(parsed)) {
    if (Array.isArray(val) && (!best || val.length > best.count)) best = { key, count: val.length, items: val };
  }
  return best;
}

// Pagination cursor. Purchase/transfer carry the id at the top level; orders
// nest theirs under "Order", so check one level down too.
const ID_KEY = /^(purchase_id|transfer_id|orderID|order_id|invoice_?id|id)$/i;

function findId(obj) {
  if (!obj || typeof obj !== "object") return null;
  const pick = (o) => Object.keys(o).find((k) => ID_KEY.test(k) && o[k] != null && typeof o[k] !== "object");
  const direct = pick(obj);
  if (direct) return String(obj[direct]);
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = pick(val);
      if (nested) return String(val[nested]);
    }
  }
  return null;
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = JSON.stringify(v);
    else out[key] = v;
  }
  return out;
}

const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Driven by the column definitions rather than by flattening every field. The
// API names some keys after timestamps (restaurant_details.uniqueFormId.2026_07_08_20_50_10),
// so a union-of-all-keys CSV grows a column per record — the CLI's own export of
// 356 records came out 811 columns wide, 744 of them junk. JSON export keeps
// full fidelity.
function toCsv(columns, rows) {
  if (!rows.length) return "";
  return [
    columns.map((c) => esc(c.label)).join(","),
    ...rows.map((r) => columns.map((c) => esc(c.get(r))).join(",")),
  ].join("\n");
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (n) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/* ---------- columns ---------- */

// total arrives as a string on purchase and sub_total as a number, so anything
// summed or right-aligned is coerced at render time.
const COLUMNS = {
  purchase: [
    { key: "_outlet", label: "Outlet", get: (r) => r._outlet },
    { key: "purchase_id", label: "Purchase ID", get: (r) => r.purchase_id },
    { key: "type", label: "Type", get: (r) => r.type },
    { key: "invoice_number", label: "Invoice #", get: (r) => r.invoice_number },
    { key: "invoice_date", label: "Invoice date", get: (r) => r.invoice_date },
    { key: "supplier", label: "Supplier", get: (r) => r.restaurant_details?.sender?.sender_name },
    { key: "total", label: "Total", get: (r) => r.total, align: "right", numeric: true },
    { key: "payment", label: "Payment", get: (r) => r.payment },
    { key: "action_status", label: "Status", get: (r) => r.action_status },
    { key: "items", label: "Items", get: (r) => (Array.isArray(r.item_details) ? r.item_details.length : 0), align: "right" },
  ],
  orders: [
    { key: "_outlet", label: "Outlet", get: (r) => r._outlet },
    { key: "orderID", label: "Order ID", get: (r) => r.Order?.orderID },
    { key: "order_date", label: "Date", get: (r) => r.Order?.order_date },
    { key: "order_type", label: "Type", get: (r) => r.Order?.order_type },
    { key: "payment_type", label: "Payment", get: (r) => r.Order?.payment_type },
    { key: "status", label: "Status", get: (r) => r.Order?.status },
    { key: "total", label: "Total", get: (r) => r.Order?.total, align: "right", numeric: true },
    { key: "items", label: "Items", get: (r) => (Array.isArray(r.OrderItem) ? r.OrderItem.length : ""), align: "right" },
  ],
};

// Transfer has no verified shape yet, so derive columns from the data itself.
function autoColumns(rows) {
  if (!rows.length) return [];
  const keys = [...new Set(rows.slice(0, 20).flatMap((r) => Object.keys(flatten(r))))].slice(0, 12);
  return keys.map((k) => ({ key: k, label: k, get: (r) => flatten(r)[k] }));
}

// Line items live under a different field per API and use unrelated key names
// (purchase's item_details vs orders' OrderItem), so both the array to read
// and the columns to render it with are looked up together.
const ITEMS = {
  purchase: {
    field: "item_details",
    columns: [
      { key: "itemname", label: "Item", get: (it) => it.itemname },
      { key: "category", label: "Category", get: (it) => it.category },
      { key: "qty", label: "Qty", get: (it) => it.qty, align: "right" },
      { key: "unit", label: "Unit", get: (it) => it.lbl_unit },
      { key: "price", label: "Rate", get: (it) => it.price, align: "right", numeric: true },
      { key: "discount", label: "Discount", get: (it) => it.discount, align: "right", numeric: true },
      { key: "amount", label: "Amount", get: (it) => it.amount, align: "right", numeric: true },
    ],
  },
  orders: {
    field: "OrderItem",
    columns: [
      { key: "name", label: "Item", get: (it) => it.name },
      { key: "categoryname", label: "Category", get: (it) => it.categoryname },
      { key: "quantity", label: "Qty", get: (it) => it.quantity, align: "right" },
      { key: "price", label: "Rate", get: (it) => it.price, align: "right", numeric: true },
      { key: "total_discount", label: "Discount", get: (it) => it.total_discount, align: "right", numeric: true },
      { key: "total", label: "Amount", get: (it) => it.total, align: "right", numeric: true },
    ],
  },
};

function itemsOf(apiType, record) {
  const field = ITEMS[apiType]?.field;
  const items = field && Array.isArray(record[field]) ? record[field] : [];
  return items;
}

/* ---------- requests ---------- */

function buildRequest(api, outlet, unit, refId) {
  // An outlet on a different Petpooja account carries its own credentials.
  const creds = outlet.credentials || api.credentials;
  const headers = { "Content-Type": "application/json" };
  if (api.cookie) headers["Cookie"] = api.cookie;

  return {
    url: api.endpoint,
    method: api.method,
    headers,
    body: JSON.stringify({ ...creds, restID: outlet.code, ...unit.params, refId: refId || "" }),
  };
}

async function callProxy(request) {
  const res = await fetch("/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  // A plain static server (VS Code Live Server, python -m http.server, …) has no
  // /proxy route and answers with 404 HTML instead of JSON.
  if (!res.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      `No API proxy at ${location.origin}/proxy — run "node server.js" and open ` +
      `http://localhost:5173/dashboard instead.`
    );
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Proxy returned ${res.status}`);
  return data;
}

// Fetch every page of every date unit for one outlet. On error it returns what
// was already collected rather than discarding it, so one bad outlet cannot
// lose another's records.
async function fetchOutletPages(api, outlet, units, { tick, isCancelled }) {
  const collected = [];

  for (const unit of units) {
    let refId = "";
    let page = 0;
    // Orders' paging behaviour is unverified, so stop if a page contributes
    // nothing new rather than looping to MAX_PAGES.
    const seen = new Set();

    while (page < MAX_PAGES) {
      if (isCancelled()) return { records: collected, cancelled: true };
      page++;
      if (tick) tick({ outlet: outlet.name, unit: unit.label, page, soFar: collected.length });

      let data;
      try {
        data = await callProxy(buildRequest(api, outlet, unit, refId));
      } catch (err) {
        return { records: collected, error: err.message };
      }

      let parsed = null;
      try { parsed = JSON.parse(data.body); } catch { /* upstream sent non-JSON */ }
      if (!parsed) return { records: collected, error: `Non-JSON response (HTTP ${data.status})` };

      const group = summarize(parsed);
      const records = group ? group.items : [];

      if (!records.length) {
        // A rejected request looks like an empty window unless the payload is
        // inspected — several outlets legitimately return 0 records with code 200.
        if (parsed.success === "0" || parsed.errorCode) {
          return {
            records: collected,
            error: `${parsed.message || "rejected"} [${parsed.code || parsed.errorCode}]`,
          };
        }
        break;
      }

      const fresh = records.filter((r) => {
        const id = findId(r);
        if (id == null) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (!fresh.length) break;

      collected.push(...fresh.map((r) => ({ _outlet: outlet.name, _rid: outlet.rid, ...r })));

      if (records.length < PAGE_SIZE) break;
      const next = findId(records[records.length - 1]);
      if (!next || next === refId) break;
      refId = next;
      await sleep(DELAY_MS, isCancelled);
    }
    await sleep(DELAY_MS, isCancelled);
  }
  return { records: collected };
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- page ---------- */

function DashboardPage({ APIS }) {
  const [apiType, setApiType] = useState("purchase");
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [selected, setSelected] = useState(() => APIS.purchase.outlets.map((o) => o.code));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  const cancelRef = useRef(false);
  const runIdRef = useRef(0);

  const api = APIS[apiType];
  const outlets = api.outlets;
  const chosen = outlets.filter((o) => selected.includes(o.code));
  const units = useMemo(() => unitsFor(apiType, startDate, endDate), [apiType, startDate, endDate]);

  const switchApi = (key) => {
    setApiType(key);
    setSelected(APIS[key].outlets.map((o) => o.code));
    setResult(null);
    setProgress(null);
    setExpanded(new Set());
  };

  const toggleExpanded = (i) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const toggle = (code) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const fetchOutlet = (outlet, tick) =>
    fetchOutletPages(api, outlet, units, { tick, isCancelled: () => cancelRef.current });

  const run = async () => {
    if (!chosen.length) return;
    cancelRef.current = false;
    const myRun = ++runIdRef.current;

    setRunning(true);
    setResult(null);
    setExpanded(new Set());
    setProgress({ outlet: chosen[0].name, unit: units[0]?.label, page: 1, soFar: 0, calls: 0 });

    const records = [];
    const errors = [];
    const perOutlet = [];
    let calls = 0;
    let cancelled = false;
    const started = Date.now();

    for (const outlet of chosen) {
      if (cancelRef.current) { cancelled = true; break; }

      const res = await fetchOutlet(outlet, (p) => {
        calls++;
        if (myRun === runIdRef.current) setProgress({ ...p, soFar: records.length + p.soFar, calls });
      });

      if (myRun !== runIdRef.current) return;

      records.push(...res.records);
      perOutlet.push({ name: outlet.name, rid: outlet.rid, count: res.records.length, error: res.error });
      if (res.error) errors.push({ outlet: outlet.name, rid: outlet.rid, message: res.error });
      if (res.cancelled) { cancelled = true; break; }
    }

    if (myRun !== runIdRef.current) return;
    setResult({ records, errors, perOutlet, calls, cancelled, ms: Date.now() - started, apiType });
    setProgress(null);
    setRunning(false);
  };

  const cancel = () => { cancelRef.current = true; };

  const columns = useMemo(() => {
    if (!result) return [];
    return COLUMNS[result.apiType] || autoColumns(result.records);
  }, [result]);

  // Keep the RID in the export even though the table shows only outlet names.
  const csvColumns = useMemo(() => {
    const rid = { key: "_rid", label: "RID", get: (r) => r._rid };
    const at = columns.findIndex((c) => c.key === "_outlet");
    return at === -1 ? [rid, ...columns] : [...columns.slice(0, at + 1), rid, ...columns.slice(at + 1)];
  }, [columns]);

  const totalValue = useMemo(() => {
    if (!result) return null;
    const col = columns.find((c) => c.numeric);
    if (!col) return null;
    return result.records.reduce((sum, r) => sum + num(col.get(r)), 0);
  }, [result, columns]);

  const stamp = `${apiType}_${isoToDmy(startDate)}_to_${isoToDmy(endDate)}`;
  const rows = result ? result.records.slice(0, MAX_TABLE_ROWS) : [];
  const itemsCfg = result ? ITEMS[result.apiType] : null;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 16px 56px", color: "var(--text-color, #1a1a1a)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Petpooja Dashboard</h1>
          <p style={{ fontSize: 13, color: "var(--muted-color, #666)", margin: "4px 0 0" }}>
            Pick dates and outlets — pagination and date windows are handled for you
          </p>
        </div>
        <div style={{ display: "flex", gap: 14, paddingTop: 4, fontSize: 13, fontWeight: 600 }}>
          <a href="index.html" style={{ color: "var(--accent-color, #2563eb)", textDecoration: "none" }}>curl builder</a>
          <a href="output.html" style={{ color: "var(--accent-color, #2563eb)", textDecoration: "none" }}>single request</a>
        </div>
      </div>

      {/* API tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {Object.entries(APIS).map(([key, val]) => (
          <button
            key={key}
            onClick={() => switchApi(key)}
            disabled={running}
            style={{
              flex: 1, padding: "10px 8px", fontSize: 13,
              fontWeight: apiType === key ? 700 : 500,
              border: apiType === key ? "2px solid var(--accent-color, #2563eb)" : "1px solid var(--border-color, #ddd)",
              borderRadius: 8,
              background: apiType === key ? "var(--accent-bg, #eff6ff)" : "transparent",
              color: apiType === key ? "var(--accent-color, #2563eb)" : "var(--text-color, #555)",
              cursor: running ? "not-allowed" : "pointer",
            }}
          >
            {val.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: "var(--muted-color, #666)", marginBottom: 16 }}>
        {api.dateNote}
      </div>

      {/* Dates */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <label style={labelStyle}>Start date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>End date</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
        </div>
      </div>

      {/* Outlets */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label style={{ ...labelStyle, margin: 0 }}>Outlets ({chosen.length}/{outlets.length})</label>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setSelected(outlets.map((o) => o.code))} disabled={running}
            style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "1px solid var(--border-color, #ddd)", borderRadius: 6, background: "transparent", color: "var(--text-color, #555)", cursor: "pointer" }}>
            All
          </button>
          <button onClick={() => setSelected([])} disabled={running}
            style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "1px solid var(--border-color, #ddd)", borderRadius: 6, background: "transparent", color: "var(--muted-color, #777)", cursor: "pointer" }}>
            None
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 6, marginBottom: 16 }}>
        {outlets.map((o) => {
          const on = selected.includes(o.code);
          return (
            <label key={o.code}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", fontSize: 13,
                border: on ? "1px solid var(--accent-color, #2563eb)" : "1px solid var(--border-color, #ddd)",
                background: on ? "var(--accent-bg, #eff6ff)" : "transparent",
                borderRadius: 6, cursor: running ? "not-allowed" : "pointer",
              }}>
              <input type="checkbox" checked={on} disabled={running} onChange={() => toggle(o.code)} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o.name}
                {o.credentials && <span style={{ color: "var(--muted-color, #888)" }}> ·alt keys</span>}
              </span>
            </label>
          );
        })}
      </div>

      {/* Run */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          onClick={run}
          disabled={running || !chosen.length}
          style={{
            flex: 1, padding: "12px", fontSize: 14, fontWeight: 700, border: "none", borderRadius: 8,
            background: running || !chosen.length ? "#9ca3af" : "var(--accent-color, #2563eb)",
            color: "#fff", cursor: running ? "wait" : !chosen.length ? "not-allowed" : "pointer",
          }}
        >
          {running
            ? "Fetching…"
            : `Fetch ${chosen.length} outlet${chosen.length === 1 ? "" : "s"} × ${units.length} ${apiType === "orders" ? "day" : "window"}${units.length === 1 ? "" : "s"}`}
        </button>
        {running && (
          <button onClick={cancel}
            style={{ padding: "12px 22px", fontSize: 14, fontWeight: 700, border: "1px solid var(--border-color, #ddd)", borderRadius: 8, background: "transparent", color: "var(--text-color, #555)", cursor: "pointer" }}>
            Cancel
          </button>
        )}
      </div>

      {progress && (
        <div style={{ padding: "10px 14px", background: "var(--info-bg, #f8f9fa)", borderRadius: 8, fontSize: 12, marginBottom: 16, color: "var(--muted-color, #666)" }}>
          <strong>{progress.outlet}</strong> · {progress.unit} · page {progress.page} · {progress.soFar} records so far · {progress.calls} calls
        </div>
      )}

      {result && (
        <div>
          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
            <Stat label="Records" value={result.records.length.toLocaleString("en-IN")} />
            <Stat label="Outlets with data" value={`${result.perOutlet.filter((o) => o.count > 0).length} / ${result.perOutlet.length}`} />
            <Stat label="API calls" value={result.calls} />
            <Stat label="Elapsed" value={`${(result.ms / 1000).toFixed(1)}s`} />
            {totalValue != null && <Stat label="Total value" value={money(totalValue)} />}
            {result.errors.length > 0 && <Stat label="Failed" value={result.errors.length} tone="bad" />}
          </div>

          {result.cancelled && (
            <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--warn-bg, #fffbeb)", border: "1px solid var(--warn-border, #fde68a)", fontSize: 12, marginBottom: 12, color: "var(--text-color, #78350f)" }}>
              Cancelled — showing the {result.records.length} records collected before stopping.
            </div>
          )}

          {result.errors.length > 0 && (
            <div style={{ borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#b91c1c" }}>
              <strong>{result.errors.length} outlet{result.errors.length === 1 ? "" : "s"} failed</strong>
              {result.errors.map((e) => (
                <div key={e.rid} style={{ marginTop: 4 }}>{e.outlet} (RID {e.rid}) — {e.message}</div>
              ))}
            </div>
          )}

          {/* Per-outlet breakdown */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {result.perOutlet.map((o) => (
              <span key={o.rid} style={{
                padding: "4px 10px", borderRadius: 999, fontSize: 12,
                background: o.error ? "#fee2e2" : o.count ? "#dcfce7" : "var(--info-bg, #f1f3f5)",
                color: o.error ? "#991b1b" : o.count ? "#166534" : "var(--muted-color, #666)",
              }}>
                {o.name}: {o.error ? "error" : o.count}
              </span>
            ))}
          </div>

          {/* Export */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...labelStyle, margin: 0 }}>
              Records{result.records.length > MAX_TABLE_ROWS ? ` — showing first ${MAX_TABLE_ROWS} of ${result.records.length}` : ""}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => download(`${stamp}.csv`, toCsv(csvColumns, result.records), "text/csv")}
                disabled={!result.records.length}
                style={{ padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "1px solid var(--border-color, #ddd)", borderRadius: 6, background: "transparent", color: "var(--text-color, #555)", cursor: "pointer" }}>
                CSV
              </button>
              <button onClick={() => download(`${stamp}.json`, JSON.stringify(result.records, null, 2), "application/json")}
                disabled={!result.records.length}
                style={{ padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 6, background: "var(--accent-color, #2563eb)", color: "#fff", cursor: "pointer" }}>
                JSON
              </button>
            </div>
          </div>

          {result.records.length === 0 ? (
            <div style={{ padding: "14px", background: "var(--info-bg, #f8f9fa)", borderRadius: 8, fontSize: 13, color: "var(--muted-color, #666)" }}>
              No records returned for this range.
            </div>
          ) : (
            <div style={{ overflow: "auto", maxHeight: "65vh", border: "1px solid var(--border-color, #ddd)", borderRadius: 8 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    {itemsCfg && <th style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--info-bg, #f8f9fa)", borderBottom: "1px solid var(--border-color, #ddd)", width: 28 }} />}
                    {columns.map((c) => (
                      <th key={c.key} style={{
                        position: "sticky", top: 0, zIndex: 1,
                        background: "var(--info-bg, #f8f9fa)", padding: "9px 10px",
                        textAlign: c.align === "right" ? "right" : "left",
                        borderBottom: "1px solid var(--border-color, #ddd)",
                        whiteSpace: "nowrap", fontWeight: 700,
                      }}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const items = itemsCfg ? itemsOf(result.apiType, r) : [];
                    const open = expanded.has(i);
                    const cells = [
                      <tr key={i}
                        onClick={itemsCfg && items.length ? () => toggleExpanded(i) : undefined}
                        style={{ cursor: itemsCfg && items.length ? "pointer" : "default" }}>
                        {itemsCfg && (
                          <td style={{ padding: "7px 4px", textAlign: "center", borderBottom: "1px solid var(--border-color, #eee)", color: "var(--muted-color, #999)" }}>
                            {items.length ? (open ? "▾" : "▸") : ""}
                          </td>
                        )}
                        {columns.map((c) => {
                          const raw = c.get(r);
                          const blank = raw === "" || raw == null;
                          return (
                            <td key={c.key} style={{
                              padding: "7px 10px",
                              textAlign: c.align === "right" ? "right" : "left",
                              borderBottom: "1px solid var(--border-color, #eee)",
                              whiteSpace: "nowrap",
                              color: blank ? "var(--muted-color, #999)" : "inherit",
                              fontVariantNumeric: c.align === "right" ? "tabular-nums" : "normal",
                            }}>
                              {blank ? "—" : c.numeric ? money(num(raw)) : String(raw)}
                            </td>
                          );
                        })}
                      </tr>,
                    ];
                    if (open && items.length) {
                      cells.push(
                        <tr key={`${i}-items`}>
                          <td colSpan={columns.length + 1} style={{ padding: 0, borderBottom: "1px solid var(--border-color, #eee)" }}>
                            <ItemsTable items={items} itemColumns={itemsCfg.columns} />
                          </td>
                        </tr>
                      );
                    }
                    return cells;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!result && !running && (
        <div style={{ padding: "10px 14px", background: "var(--info-bg, #f8f9fa)", borderRadius: 8, fontSize: 12, lineHeight: 1.7, color: "var(--muted-color, #666)" }}>
          {units.length} API call{units.length === 1 ? "" : "s"} per outlet for this range, plus one per extra page of 50 records.
          <br />Requests are throttled {DELAY_MS}ms apart and run one at a time.
        </div>
      )}
    </div>
  );
}

function ItemsTable({ items, itemColumns }) {
  const amountCol = itemColumns.find((c) => c.numeric && /amount|total/i.test(c.key));
  const sum = amountCol ? items.reduce((s, it) => s + num(amountCol.get(it)), 0) : null;

  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, background: "var(--info-bg, #f8f9fa)" }}>
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          {itemColumns.map((c) => (
            <th key={c.key} style={{
              padding: "6px 10px", textAlign: c.align === "right" ? "right" : "left",
              color: "var(--muted-color, #777)", fontWeight: 600, fontSize: 11,
              textTransform: "uppercase", letterSpacing: "0.03em", whiteSpace: "nowrap",
            }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i}>
            <td />
            {itemColumns.map((c) => {
              const raw = c.get(it);
              const blank = raw === "" || raw == null;
              return (
                <td key={c.key} style={{
                  padding: "5px 10px", textAlign: c.align === "right" ? "right" : "left",
                  whiteSpace: "nowrap", color: blank ? "var(--muted-color, #999)" : "inherit",
                  fontVariantNumeric: c.align === "right" ? "tabular-nums" : "normal",
                }}>
                  {blank ? "—" : c.numeric ? money(num(raw)) : String(raw)}
                </td>
              );
            })}
          </tr>
        ))}
        {sum != null && (
          <tr>
            <td />
            <td colSpan={itemColumns.length - 1} style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: "var(--muted-color, #777)" }}>
              {items.length} item{items.length === 1 ? "" : "s"} · total
            </td>
            <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {money(sum)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{
      padding: "10px 14px", borderRadius: 8,
      background: tone === "bad" ? "#fef2f2" : "var(--info-bg, #f8f9fa)",
      border: tone === "bad" ? "1px solid #fecaca" : "1px solid transparent",
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: tone === "bad" ? "#b91c1c" : "var(--muted-color, #777)" }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2, color: tone === "bad" ? "#b91c1c" : "inherit" }}>
        {value}
      </div>
    </div>
  );
}
