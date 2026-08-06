import { useState, useMemo } from "react";

// Two credential sets covering different outlets: BILLING reaches Aiko, INVENTORY
// reaches the ten inventory outlets. They are not interchangeable — using one on
// the other's outlets returns "There were some error in restaurant mapping".
const BILLING = {
  app_key: "uvw0th4nksi97o1bgqp35zjxr6e2may8",
  app_secret: "9450cbbbb22be056537e82138f1fa15220656e9b",
  access_token: "9949a4aea79acad2e22e501e89c5ff3146f15e48",
};

const INVENTORY = {
  app_key: "rpvg7joamn421d3u0x5qhk9ze8sibtcw",
  app_secret: "c7b1e4b80a2d1bfbf67da2bc81ca9dd9bf019b3e",
  // 40 hex chars. An earlier copy of this dropped the "0" at position 31, which
  // failed as "Invalid Token" (GN_102) and looked like a provisioning problem.
  access_token: "7334c01be3a9677868cbf1402880340e79e1ea84",
};

const APIS = {
  orders: {
    label: "Orders API",
    method: "GET",
    endpoint: "https://api.petpooja.com/V1/thirdparty/generic_get_orders/",
    dateFormat: "YYYY-MM-DD",
    dateNote: "T-1: enter today's date to get yesterday's orders",
    credentials: BILLING,
    cookie: "PETPOOJA_API=mgnhpm6a8r5u11gatkpqhg7q00",
    outlets: [
      { name: "Aiko (Ahmedabad)", rid: "134691", code: "z2ogsrb0" },
    ],
  },
  purchase: {
    label: "Purchase API",
    method: "POST",
    endpoint: "https://api.petpooja.com/V1/thirdparty/get_purchase/",
    dateFormat: "DD-MM-YYYY",
    dateNote: "Date range must be 1 month or less; 50 records per call",
    credentials: INVENTORY,
    cookie: null,
    // Aiko sits on the billing account, so it overrides the API's credentials.
    outlets: [
      { name: "Ahmedabad Prep Kitchen", rid: "410150", code: "opw2xhc6vg" },
      { name: "Surat Prep Kitchen", rid: "376017", code: "kv4roawcjf" },
      { name: "Ahmedabad Bakery", rid: "410700", code: "eh0x8kt3d2" },
      { name: "Ahmedabad Store", rid: "358609", code: "4pwgfxrzs2" },
      { name: "Family", rid: "394370", code: "x74bivacjk" },
      { name: "KG Birthday Cake", rid: "383611", code: "9zrehnckm6" },
      { name: "ODC", rid: "423523", code: "jprtvkud2b" },
      { name: "ODC Store", rid: "404029", code: "8okipxz7r5" },
      { name: "Surat Bakery", rid: "343448", code: "cjkf5gi2" },
      { name: "Surat Store", rid: "117185", code: "d6pbazgs" },
      { name: "Aiko (Ahmedabad)", rid: "134691", code: "z2ogsrb0", credentials: BILLING },
    ],
  },
  transfer: {
    label: "Inventory Transfer API",
    method: "POST",
    endpoint: "https://api.petpooja.com/V1/thirdparty/get_transfer/",
    dateFormat: "DD-MM-YYYY",
    dateNote: "Not yet working — returns \"Invalid request\" (GN_103) for every outlet",
    credentials: INVENTORY,
    cookie: null,
    outlets: [
      { name: "Ahmedabad Bakery", rid: "410700", code: "eh0x8kt3d2" },
      { name: "Ahmedabad Store", rid: "358609", code: "4pwgfxrzs2" },
      { name: "Family", rid: "394370", code: "x74bivacjk" },
      { name: "KG Birthday Cake", rid: "383611", code: "9zrehnckm6" },
      { name: "ODC", rid: "423523", code: "jprtvkud2b" },
      { name: "ODC Store", rid: "404029", code: "8okipxz7r5" },
      { name: "Surat Bakery", rid: "343448", code: "cjkf5gi2" },
      { name: "Surat Store", rid: "117185", code: "d6pbazgs" },
    ],
  },
};

function formatDate(dateStr, format) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return format === "DD-MM-YYYY" ? `${d}-${m}-${y}` : dateStr;
}

function todayStr() {
  const d = new Date();
  return d.toISOString().split("T")[0];
}

export default function PetpoojaApiTester() {
  const [apiType, setApiType] = useState("orders");
  const [outletIdx, setOutletIdx] = useState(0);
  const [date, setDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [refId, setRefId] = useState("");
  const [copied, setCopied] = useState(false);

  const api = APIS[apiType];
  const outlet = api.outlets[outletIdx] || api.outlets[0];

  const curlCommand = useMemo(() => {
    // An outlet on a different Petpooja account carries its own credentials.
    const creds = outlet.credentials || api.credentials;
    const formattedDate = formatDate(date, api.dateFormat);
    const formattedEndDate = formatDate(endDate, api.dateFormat);

    if (apiType === "orders") {
      const body = JSON.stringify(
        {
          app_key: creds.app_key,
          app_secret: creds.app_secret,
          access_token: creds.access_token,
          restID: outlet.code,
          order_date: formattedDate,
          refId: refId || "",
        },
        null,
        2
      );
      return `curl --location --request GET '${api.endpoint}' \\
  --header 'Cookie: ${api.cookie}' \\
  --header 'Content-Type: application/json' \\
  --data '${body}'`;
    }

    const body = JSON.stringify(
      {
        app_key: creds.app_key,
        app_secret: creds.app_secret,
        access_token: creds.access_token,
        restID: outlet.code,
        // from_date/to_date, not start_date/end_date — the latter is rejected
        // with "Please provide all request parameters." (code 100).
        from_date: formattedDate,
        to_date: formattedEndDate,
        refId: refId || "",
      },
      null,
      2
    );
    return `curl --location --request POST '${api.endpoint}' \\
  --header 'Content-Type: application/json' \\
  --data '${body}'`;
  }, [apiType, outletIdx, date, endDate, refId, api, outlet]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(curlCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = curlCommand;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: "24px 16px", color: "var(--text-color, #1a1a1a)" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          Petpooja API Tester
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted-color, #666)", margin: "4px 0 0" }}>
          Select API, outlet & date → copy the curl → paste in terminal
        </p>
      </div>

      {/* API selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {Object.entries(APIS).map(([key, val]) => (
          <button
            key={key}
            onClick={() => { setApiType(key); setOutletIdx(0); }}
            style={{
              flex: 1,
              padding: "10px 8px",
              fontSize: 13,
              fontWeight: apiType === key ? 700 : 500,
              border: apiType === key ? "2px solid var(--accent-color, #2563eb)" : "1px solid var(--border-color, #ddd)",
              borderRadius: 8,
              background: apiType === key ? "var(--accent-bg, #eff6ff)" : "transparent",
              color: apiType === key ? "var(--accent-color, #2563eb)" : "var(--text-color, #555)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {val.label}
          </button>
        ))}
      </div>

      {/* Config grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginBottom: 16,
      }}>
        {/* Outlet */}
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={labelStyle}>Outlet</label>
          <select
            value={outletIdx}
            onChange={(e) => setOutletIdx(Number(e.target.value))}
            style={inputStyle}
          >
            {api.outlets.map((o, i) => (
              <option key={i} value={i}>
                {o.name} — RID {o.rid}
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label style={labelStyle}>
            {apiType === "orders" ? "Order Date (T-1)" : "Start Date"}
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={inputStyle}
          />
        </div>

        {apiType !== "orders" ? (
          <div>
            <label style={labelStyle}>End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={inputStyle}
            />
          </div>
        ) : (
          <div>
            <label style={labelStyle}>refId (pagination)</label>
            <input
              type="text"
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
              placeholder="Leave empty for first page"
              style={inputStyle}
            />
          </div>
        )}

        {apiType !== "orders" && (
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>refId (pagination)</label>
            <input
              type="text"
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
              placeholder="Use last purchase_id / transfer_id for next page"
              style={inputStyle}
            />
          </div>
        )}
      </div>

      {/* Info bar */}
      <div style={{
        display: "flex",
        gap: 16,
        padding: "10px 14px",
        background: "var(--info-bg, #f8f9fa)",
        borderRadius: 8,
        marginBottom: 16,
        fontSize: 12,
        color: "var(--muted-color, #666)",
        flexWrap: "wrap",
      }}>
        <span><strong>Method:</strong> {api.method}</span>
        <span><strong>Date format:</strong> {api.dateFormat}</span>
        <span><strong>Outlet code:</strong> {outlet.code}</span>
      </div>

      {/* Curl output */}
      <div style={{ position: "relative" }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}>
          <label style={{ ...labelStyle, margin: 0 }}>curl command</label>
          <button
            onClick={handleCopy}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 600,
              border: "none",
              borderRadius: 6,
              background: copied ? "#16a34a" : "var(--accent-color, #2563eb)",
              color: "#fff",
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        <pre style={{
          background: "var(--code-bg, #1e1e1e)",
          color: "var(--code-text, #d4d4d4)",
          padding: 16,
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: 0,
        }}>
          {curlCommand}
        </pre>
      </div>

      {/* Tips */}
      <div style={{
        marginTop: 20,
        padding: "12px 14px",
        background: "var(--warn-bg, #fffbeb)",
        border: "1px solid var(--warn-border, #fde68a)",
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.6,
        color: "var(--text-color, #78350f)",
      }}>
        <strong>Quick tips:</strong>
        <br />• {api.dateNote}
        <br />• Pipe output through <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 4px", borderRadius: 3 }}>| python3 -m json.tool</code> for formatted JSON
        <br />• For pagination, copy the last ID from the response and paste it in the refId field
        {apiType === "orders" && (
          <>
            <br />• Only Aiko (Ahmedabad) is configured so far — other outlet codes will be shared by Petpooja after confirmation
          </>
        )}
      </div>
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted-color, #555)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const inputStyle = {
  width: "100%",
  padding: "9px 10px",
  fontSize: 14,
  border: "1px solid var(--border-color, #ddd)",
  borderRadius: 6,
  background: "var(--input-bg, #fff)",
  color: "var(--text-color, #1a1a1a)",
  boxSizing: "border-box",
};
