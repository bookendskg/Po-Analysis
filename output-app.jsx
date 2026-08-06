const { useState, useMemo, useRef } = React;

const labelStyle = {
  display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted-color, #555)",
  marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em",
};

/* ---------- curl parsing ---------- */

// Split a shell command into tokens, honouring quotes and the backslash
// line-continuations that the builder page emits.
function tokenizeCurl(input) {
  const s = input.replace(/\\\r?\n/g, " ").trim();
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    const quote = s[i];
    if (quote === "'" || quote === '"') {
      i++;
      let buf = "";
      while (i < s.length && s[i] !== quote) {
        // Backslashes are literal inside single quotes; only double quotes escape.
        if (s[i] === "\\" && quote === '"' && i + 1 < s.length) {
          buf += s[i + 1];
          i += 2;
          continue;
        }
        buf += s[i++];
      }
      if (i >= s.length) throw new Error(`Unclosed ${quote} quote in the command`);
      i++;
      tokens.push(buf);
    } else {
      let buf = "";
      while (i < s.length && !/\s/.test(s[i])) buf += s[i++];
      tokens.push(buf);
    }
  }
  return tokens;
}

const BODY_FLAGS = ["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"];
const NO_ARG_FLAGS = ["-L", "--location", "-s", "--silent", "-k", "--insecure", "--compressed", "-i", "-v", "--verbose", "-g"];

function parseCurl(input) {
  const tokens = tokenizeCurl(input);
  if (!tokens.length) throw new Error("Nothing to run — paste a curl command first");
  if (tokens[0] !== "curl") throw new Error(`Expected the command to start with "curl", got "${tokens[0]}"`);

  let method = null;
  let url = null;
  let body = null;
  const headers = {};

  for (let i = 1; i < tokens.length; i++) {
    let flag = tokens[i];
    let inline = null;

    // Support --flag=value as well as --flag value.
    if (flag.startsWith("--") && flag.includes("=")) {
      const at = flag.indexOf("=");
      inline = flag.slice(at + 1);
      flag = flag.slice(0, at);
    }
    const value = () => (inline !== null ? inline : tokens[++i]);

    if (flag === "-X" || flag === "--request") {
      method = String(value() || "").toUpperCase();
    } else if (flag === "-H" || flag === "--header") {
      const raw = value() || "";
      const at = raw.indexOf(":");
      if (at > -1) headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
    } else if (BODY_FLAGS.includes(flag)) {
      body = value();
    } else if (flag === "-b" || flag === "--cookie") {
      headers["Cookie"] = value();
    } else if (flag === "-A" || flag === "--user-agent") {
      headers["User-Agent"] = value();
    } else if (NO_ARG_FLAGS.includes(flag)) {
      /* nothing to consume */
    } else if (!flag.startsWith("-") && !url) {
      url = flag;
    }
  }

  if (!url) throw new Error("No URL found in the curl command");
  if (!method) method = body ? "POST" : "GET";
  return { url, method, headers, body };
}

/* ---------- response helpers ---------- */

function prettyBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Escapes before tagging, so response content can never inject markup.
function highlight(json) {
  return escapeHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "tok-num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "tok-key" : "tok-str";
      else if (/true|false/.test(m)) cls = "tok-bool";
      else if (/null/.test(m)) cls = "tok-null";
      return `<span class="${cls}">${m}</span>`;
    }
  );
}

// Petpooja names its record array differently per endpoint, so report the
// largest array in the payload rather than hardcoding key names.
function summarize(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  let best = null;
  for (const [key, val] of Object.entries(parsed)) {
    if (Array.isArray(val) && (!best || val.length > best.count)) best = { key, count: val.length, items: val };
  }
  return best;
}

// Purchase/transfer records carry the id at the top level; orders nest theirs
// under "Order", so look one level down too.
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

/* ---------- page ---------- */

const PLACEHOLDER = `curl --location --request GET 'https://api.petpooja.com/V1/thirdparty/generic_get_orders/' \\
  --header 'Cookie: PETPOOJA_API=…' \\
  --header 'Content-Type: application/json' \\
  --data '{ … }'`;

function OutputPage() {
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState("pretty");
  const [copied, setCopied] = useState(false);
  const reqId = useRef(0);

  // Live preview of what will actually be sent, so a malformed paste shows
  // up before the request goes out.
  const preview = useMemo(() => {
    if (!command.trim()) return null;
    try {
      return { request: parseCurl(command), error: null };
    } catch (err) {
      return { request: null, error: err.message };
    }
  }, [command]);

  const run = async () => {
    let request;
    try {
      request = parseCurl(command);
    } catch (err) {
      setError(err.message);
      setResult(null);
      return;
    }

    // Stamp each run so a slow earlier response can't overwrite a newer one.
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      // A plain static server (VS Code Live Server, python -m http.server, …)
      // has no /proxy route and answers with 404 HTML instead of JSON.
      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error(
          `No API proxy at ${location.origin}/proxy — this page is being served by a plain ` +
          `static server. Run "node server.js" and open http://localhost:5173/output instead.`
        );
      }

      const data = await res.json();
      if (myId !== reqId.current) return;
      if (!res.ok) throw new Error(data.error || `Proxy returned ${res.status}`);

      let parsed = null;
      try { parsed = JSON.parse(data.body); } catch { /* upstream sent non-JSON */ }
      setResult({ ...data, parsed, request });
    } catch (err) {
      if (myId === reqId.current) setError(err.message);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setCommand(text);
    } catch {
      setError("Clipboard read was blocked by the browser — paste with Ctrl+V instead");
    }
  };

  const copyResponse = async () => {
    if (!result) return;
    const text = result.parsed ? JSON.stringify(result.parsed, null, 2) : result.body;
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const group = result ? summarize(result.parsed) : null;
  const lastId = findId(group && group.items.length ? group.items[group.items.length - 1] : null);
  const ok = result && result.status >= 200 && result.status < 300;
  const bodyText = result ? (view === "pretty" && result.parsed ? JSON.stringify(result.parsed, null, 2) : result.body) : "";

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 48px", color: "var(--text-color, #1a1a1a)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Petpooja API Output</h1>
          <p style={{ fontSize: 13, color: "var(--muted-color, #666)", margin: "4px 0 0" }}>
            Paste the curl from the builder → run it → response appears below
          </p>
        </div>
        <div style={{ display: "flex", gap: 14, paddingTop: 4, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
          <a href="index.html" style={{ color: "var(--accent-color, #2563eb)", textDecoration: "none" }}>← curl builder</a>
          <a href="dashboard.html" style={{ color: "var(--accent-color, #2563eb)", textDecoration: "none" }}>dashboard</a>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label style={{ ...labelStyle, margin: 0 }}>curl command</label>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={pasteFromClipboard}
            style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "1px solid var(--border-color, #ddd)", borderRadius: 6, background: "transparent", color: "var(--text-color, #555)", cursor: "pointer" }}
          >
            Paste
          </button>
          <button
            onClick={() => { setCommand(""); setResult(null); setError(null); }}
            disabled={!command}
            style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "1px solid var(--border-color, #ddd)", borderRadius: 6, background: "transparent", color: "var(--muted-color, #777)", cursor: command ? "pointer" : "not-allowed" }}
          >
            Clear
          </button>
        </div>
      </div>

      <textarea
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(); }}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        rows={9}
        style={{
          width: "100%", boxSizing: "border-box", padding: 14, borderRadius: 8,
          border: "1px solid var(--border-color, #ddd)",
          background: "var(--code-bg, #1e1e1e)", color: "var(--code-text, #d4d4d4)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12, lineHeight: 1.6, resize: "vertical",
        }}
      />

      {preview && preview.error && (
        <div style={{ fontSize: 12, color: "#b45309", marginTop: 6 }}>
          Could not parse: {preview.error}
        </div>
      )}

      {preview && preview.request && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--muted-color, #666)", marginTop: 8 }}>
          <span><strong>{preview.request.method}</strong></span>
          <span>{(() => { try { return new URL(preview.request.url).host; } catch { return preview.request.url; } })()}</span>
          <span>{Object.keys(preview.request.headers).length} headers</span>
          <span>{preview.request.body ? prettyBytes(preview.request.body.length) + " body" : "no body"}</span>
        </div>
      )}

      <button
        onClick={run}
        disabled={loading || !command.trim()}
        style={{
          width: "100%", padding: "12px", fontSize: 14, fontWeight: 700, border: "none",
          borderRadius: 8, marginTop: 14, marginBottom: 18, color: "#fff",
          background: loading || !command.trim() ? "#9ca3af" : "var(--accent-color, #2563eb)",
          cursor: loading ? "wait" : !command.trim() ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "Running…" : "Run request  (Ctrl+Enter)"}
      </button>

      {error && (
        <div style={{ padding: "12px 14px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          <strong>Request failed:</strong> {error}
        </div>
      )}

      {result && (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <span style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700, background: ok ? "#dcfce7" : "#fee2e2", color: ok ? "#166534" : "#991b1b" }}>
              {result.status} {result.statusText}
            </span>
            <span style={{ fontSize: 12, color: "var(--muted-color, #666)" }}>{result.ms} ms</span>
            <span style={{ fontSize: 12, color: "var(--muted-color, #666)" }}>{prettyBytes(result.body.length)}</span>
            {group && (
              <span style={{ fontSize: 12, color: "var(--muted-color, #666)" }}>
                <strong>{group.count}</strong> records in <code>{group.key}</code>
              </span>
            )}
            {!result.parsed && <span style={{ fontSize: 12, color: "#b45309" }}>response was not JSON</span>}
          </div>

          {lastId && (
            <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--warn-bg, #fffbeb)", border: "1px solid var(--warn-border, #fde68a)", fontSize: 12, marginBottom: 12, color: "var(--text-color, #78350f)" }}>
              Last record id on this page: <code>{lastId}</code> — put it in the builder's refId field for the next page.
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <label style={{ ...labelStyle, margin: 0 }}>Response</label>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setView(view === "pretty" ? "raw" : "pretty")}
                disabled={!result.parsed}
                style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "1px solid var(--border-color, #ddd)", borderRadius: 6, background: "transparent", color: "var(--text-color, #555)", cursor: result.parsed ? "pointer" : "not-allowed" }}
              >
                {view === "pretty" ? "Raw" : "Pretty"}
              </button>
              <button
                onClick={copyResponse}
                style={{ padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 6, background: copied ? "#16a34a" : "var(--accent-color, #2563eb)", color: "#fff", cursor: "pointer" }}
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>
          </div>

          <pre
            style={{
              background: "var(--code-bg, #1e1e1e)", color: "var(--code-text, #d4d4d4)",
              padding: 16, borderRadius: 8, fontSize: 12, lineHeight: 1.6,
              overflow: "auto", maxHeight: "65vh", margin: 0,
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}
            dangerouslySetInnerHTML={{
              __html: view === "pretty" && result.parsed ? highlight(bodyText) : escapeHtml(bodyText),
            }}
          />
        </div>
      )}

      {!result && !error && !loading && (
        <div style={{ padding: "10px 14px", background: "var(--info-bg, #f8f9fa)", borderRadius: 8, fontSize: 12, lineHeight: 1.7, color: "var(--muted-color, #666)" }}>
          Copy a command on the <a href="index.html" style={{ color: "var(--accent-color, #2563eb)" }}>builder page</a>, paste it above, and hit Run.
          <br />Only <code>api.petpooja.com</code> and <code>inventory.petpooja.com</code> can be reached through the proxy.
        </div>
      )}
    </div>
  );
}

