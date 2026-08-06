#!/usr/bin/env node
/**
 * Petpooja Inventory API fetcher — Purchase & Transfer
 * ------------------------------------------------------------------
 * Fetches purchase or inventory-transfer records for a date range,
 * follows pagination automatically (50 records/call), writes JSON + CSV.
 *
 * Requires Node 18+ (global fetch).
 *
 * Usage:
 *   node fetch-petpooja.mjs <api> <outlet|all> <start> <end>
 *
 *   node fetch-petpooja.mjs purchase ahd-prep   01-08-2026 05-08-2026
 *   node fetch-petpooja.mjs purchase all        01-07-2026 31-07-2026
 *   node fetch-petpooja.mjs transfer surat-bakery 01-08-2026 05-08-2026
 *
 * Dates are DD-MM-YYYY.
 *
 * Credentials via env (keep them out of git):
 *   export PP_APP_KEY="..."
 *   export PP_APP_SECRET="..."
 *   export PP_ACCESS_TOKEN="..."
 */

import { writeFileSync, mkdirSync } from "node:fs";

// ------------------------------------------------------------------
// APIs
// ------------------------------------------------------------------

// Host is api.petpooja.com, NOT inventory.petpooja.com — the inventory host
// returns an HTML 404 for these routes.
const APIS = {
  purchase: {
    endpoint: "https://api.petpooja.com/V1/thirdparty/get_purchase/",
    cursorFields: ["purchase_id", "purchaseId", "id"],
    arrayKeys: ["purchases", "purchase", "purchase_details", "data", "result"],
  },
  transfer: {
    endpoint: "https://api.petpooja.com/V1/thirdparty/get_transfer/",
    cursorFields: ["transfer_id", "transferId", "id"],
    arrayKeys: ["transfers", "transfer", "transfer_details", "data", "result"],
  },
};

// The API rejects windows longer than a month ("code":"101"), so long ranges
// are split and the pages of each window concatenated.
const MAX_WINDOW_DAYS = 30;

// ------------------------------------------------------------------
// Outlets
//
// `code` is the Menu Sharing Sync Code — this is what goes in restID,
// NOT the RID. Outlets with code: null are activated for Purchase but
// Petpooja has not yet supplied a sharing code.
// ------------------------------------------------------------------

const OUTLETS = {
  // Prep kitchens — Purchase + Transfer
  "ahd-prep":        { name: "Ahmedabad Prep Kitchen", rid: "410150", code: "opw2xhc6vg" },
  "surat-prep":      { name: "Surat Prep Kitchen",     rid: "376017", code: "kv4roawcjf" },

  // Transfer API batch — also valid for Purchase
  "ahd-bakery":      { name: "Ahmedabad Bakery",       rid: "410700", code: "eh0x8kt3d2" },
  "ahd-store":       { name: "Ahmedabad Store",        rid: "358609", code: "4pwgfxrzs2" },
  "family":          { name: "Family",                 rid: "394370", code: "x74bivacjk" },
  "kg-cake":         { name: "KG Birthday Cake",       rid: "383611", code: "9zrehnckm6" },
  "odc":             { name: "ODC",                    rid: "423523", code: "jprtvkud2b" },
  "odc-store":       { name: "ODC Store",              rid: "404029", code: "8okipxz7r5" },
  "surat-bakery":    { name: "Surat Bakery",           rid: "343448", code: "cjkf5gi2"   },
  "surat-store":     { name: "Surat Store",            rid: "117185", code: "d6pbazgs"   },

  // Aiko Ahmedabad — on the billing account, not the inventory one
  "aiko-ahd":        { name: "Aiko (Ahmedabad)",       rid: "134691", code: "z2ogsrb0", billing: true },

  // Awaiting Menu Sharing Codes from Petpooja
  "aiko-surat":      { name: "Aiko (Surat)",           rid: "73492",  code: null },
  "bookends-mobile": { name: "Bookends mobile",        rid: "359628", code: null },
  "capiche-ahd":     { name: "Capiche (Ahmedabad)",    rid: "353369", code: null },
  "capiche-piplod":  { name: "Capiche (Piplod)",       rid: "21492",  code: null },
  "capiche-vesu":    { name: "Capiche (Vesu)",         rid: "344447", code: null },
  "capiche-ahd-2":   { name: "Capiche Ahmedabad 2.0",  rid: "419174", code: null },
  "accounts":        { name: "Accounts Department",    rid: "451175", code: null },
};

// Inventory credentials cover the ten inventory outlets. Aiko sits on the
// billing account and needs its own set — supply PP_BILLING_* to reach it.
const CREDS = {
  app_key:      process.env.PP_APP_KEY,
  app_secret:   process.env.PP_APP_SECRET,
  access_token: process.env.PP_ACCESS_TOKEN,
};

const BILLING_CREDS = process.env.PP_BILLING_APP_KEY && {
  app_key:      process.env.PP_BILLING_APP_KEY,
  app_secret:   process.env.PP_BILLING_APP_SECRET,
  access_token: process.env.PP_BILLING_ACCESS_TOKEN,
};

const PAGE_SIZE = 50;
const MAX_PAGES = 200;
const DELAY_MS  = 400;
const OUT_DIR   = "petpooja-data";

// ------------------------------------------------------------------
// Args & validation
// ------------------------------------------------------------------

const [apiKey, outletKey, startDate, endDate] = process.argv.slice(2);

function usage(msg) {
  if (msg) console.error(`\n${msg}\n`);
  console.error("Usage: node fetch-petpooja.mjs <purchase|transfer> <outlet|all> <DD-MM-YYYY> <DD-MM-YYYY>\n");
  console.error("Outlets with codes:");
  for (const [k, o] of Object.entries(OUTLETS)) {
    if (o.code) console.error(`  ${k.padEnd(16)} ${o.name} (RID ${o.rid})`);
  }
  console.error("\nAwaiting sharing code from Petpooja:");
  for (const [k, o] of Object.entries(OUTLETS)) {
    if (!o.code) console.error(`  ${k.padEnd(16)} ${o.name} (RID ${o.rid})`);
  }
  process.exit(1);
}

const api = APIS[(apiKey || "").toLowerCase()];
if (!api) usage(`Unknown API "${apiKey}". Use "purchase" or "transfer".`);
if (!outletKey || !startDate || !endDate) usage("Missing arguments.");

const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
for (const [label, d] of [["start", startDate], ["end", endDate]]) {
  if (!DATE_RE.test(d)) usage(`${label} date must be DD-MM-YYYY (got "${d}").`);
}

for (const [k, v] of Object.entries(CREDS)) {
  if (!v) usage(`Missing env var PP_${k.toUpperCase()}`);
}

// Petpooja tokens and secrets are 40-char hex. Catch transcription slips early.
for (const [k, v] of Object.entries(CREDS)) {
  if (k === "app_key") continue;
  if (!/^[0-9a-f]{40}$/i.test(v)) {
    console.warn(`WARNING: ${k} is ${v.length} chars — expected 40 hex chars. Check for a dropped character.`);
  }
}

let targets;
if (outletKey.toLowerCase() === "all") {
  targets = Object.entries(OUTLETS).filter(([, o]) => o.code);
} else {
  const o = OUTLETS[outletKey.toLowerCase()];
  if (!o) usage(`Unknown outlet "${outletKey}".`);
  if (!o.code) usage(`${o.name} (RID ${o.rid}) has no Menu Sharing Code yet — request it from Petpooja.`);
  targets = [[outletKey.toLowerCase(), o]];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseDmy = (s) => {
  const [d, m, y] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const toDmy = (dt) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
};

// Split an arbitrary range into windows the API will accept.
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

function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  for (const key of api.arrayKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const val of Object.values(payload)) {
    if (Array.isArray(val) && val.length && typeof val[0] === "object") return val;
    if (val && typeof val === "object") {
      const nested = extractRecords(val);
      if (nested.length) return nested;
    }
  }
  return [];
}

function cursorFrom(record) {
  if (!record) return null;
  for (const f of api.cursorFields) {
    if (record[f] != null) return String(record[f]);
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

function toCsv(rows) {
  if (!rows.length) return "";
  const flat = rows.map((r) => flatten(r));
  const headers = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...flat.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

// ------------------------------------------------------------------
// Fetch
// ------------------------------------------------------------------

async function fetchPage(outlet, refId, from, to) {
  const res = await fetch(api.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(outlet.billing && BILLING_CREDS ? BILLING_CREDS : CREDS),
      restID: outlet.code,
      // from_date/to_date, not start_date/end_date — the latter is silently
      // rejected with "Please provide all request parameters." (code 100).
      from_date: from,
      to_date: to,
      refId: refId ?? "",
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\n${text.slice(0, 400)}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response:\n${text.slice(0, 400)}`);
  }
}

async function fetchOutlet(key, outlet) {
  console.log(`\n${outlet.name} (RID ${outlet.rid} / ${outlet.code})`);

  const windows = dateWindows(startDate, endDate);
  if (windows.length > 1) console.log(`  range split into ${windows.length} windows (max 1 month each)`);

  const all = [];

  for (const [from, to] of windows) {
    if (windows.length > 1) console.log(`  ${from} → ${to}`);

    let refId = "";
    let page = 0;

    while (page < MAX_PAGES) {
      page++;
      process.stdout.write(`  page ${page}... `);

      let payload;
      try {
        payload = await fetchPage(outlet, refId, from, to);
      } catch (err) {
        console.log(`FAILED — ${err.message.split("\n")[0]}`);
        return { key, outlet, records: all, error: err.message };
      }

      const records = extractRecords(payload);

      if (!records.length) {
        // A rejected request looks the same as an empty window, so surface the
        // API's own message rather than reporting a silent zero.
        if (payload?.success === "0" || payload?.errorCode) {
          const detail = `${payload.message || "rejected"} [${payload.code || payload.errorCode}]`;
          console.log(`API error — ${detail}`);
          return { key, outlet, records: all, error: detail, raw: payload };
        }
        console.log("no records.");
        break;
      }

      console.log(`${records.length} records`);
      all.push(...records.map((r) => ({ _outlet: outlet.name, _rid: outlet.rid, ...r })));

      if (records.length < PAGE_SIZE) break;

      const next = cursorFrom(records[records.length - 1]);
      if (!next || next === refId) {
        console.log("    no further cursor — stopping.");
        break;
      }
      refId = next;
      await sleep(DELAY_MS);
    }

    if (windows.length > 1) await sleep(DELAY_MS);
  }

  return { key, outlet, records: all };
}

async function main() {
  console.log(`API    : ${apiKey.toLowerCase()}`);
  console.log(`Range  : ${startDate} → ${endDate}`);
  console.log(`Outlets: ${targets.length}`);

  mkdirSync(OUT_DIR, { recursive: true });

  const combined = [];
  const failures = [];

  for (const [key, outlet] of targets) {
    const result = await fetchOutlet(key, outlet);
    if (result.error) failures.push(result);
    combined.push(...result.records);
    if (targets.length > 1) await sleep(DELAY_MS);
  }

  const stamp = `${apiKey.toLowerCase()}_${outletKey.toLowerCase()}_${startDate}_to_${endDate}`;
  writeFileSync(`${OUT_DIR}/${stamp}.json`, JSON.stringify(combined, null, 2));
  writeFileSync(`${OUT_DIR}/${stamp}.csv`, toCsv(combined));

  console.log(`\n─────────────────────────────────────`);
  console.log(`Total: ${combined.length} records`);
  console.log(`  ${OUT_DIR}/${stamp}.json`);
  console.log(`  ${OUT_DIR}/${stamp}.csv`);

  if (failures.length) {
    console.log(`\nFailed outlets: ${failures.map((f) => f.outlet.name).join(", ")}`);
  }
  if (combined.length) {
    console.log(`\nFields: ${Object.keys(flatten(combined[0])).join(", ")}`);
  }
}

main().catch((err) => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
