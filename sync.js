// sync.js
// Runs once daily (10pm Malaysia time) via GitHub Actions.
// Pulls tomorrow's appointments from the CRM feed and writes each branch's
// list into that branch's own Firebase Realtime Database, under board_v2/queue.
//
// Nothing secret lives in this file. The CRM token and each branch's Firebase
// service-account credentials are read from environment variables, which
// GitHub Actions injects from repo Secrets at run time.

const admin = require("firebase-admin");

// ---- Branch config -------------------------------------------------------
// Database URLs are NOT secret (they already sit in plain sight in each
// board's public HTML), so they're hardcoded here for simplicity. Only the
// service-account key per branch is sensitive, and that's read from env.
const BRANCHES = {
  GL:  { dbURL: "https://urgreenlane-default-rtdb.firebaseio.com", schema: "v2" },
  SS2: { dbURL: "https://urss2-8597b-default-rtdb.asia-southeast1.firebasedatabase.app", schema: "v2" },
  RU:  { dbURL: "https://urru-f9b89-default-rtdb.asia-southeast1.firebasedatabase.app", schema: "v1" },
  MA:  { dbURL: "https://urma-f8632-default-rtdb.asia-southeast1.firebasedatabase.app", schema: "v1" },
  SU:  { dbURL: "https://ursu-44644-default-rtdb.asia-southeast1.firebasedatabase.app", schema: "v1" },
  BM:  { dbURL: "https://urbm-d3279-default-rtdb.asia-southeast1.firebasedatabase.app", schema: "v1" },
};
// NOTE: when GL moves to v2, just change its schema above to "v2" — nothing else needs to change.

// ---- Helpers ---------------------------------------------------------------

// CRM gives "18/Jul/2025" (DD/Mon/YYYY). Build the same string for "tomorrow"
// so we can filter StartDate against it directly, no date-library needed.
function tomorrowCrmDateString() {
  const now = new Date();
  // Shift to Malaysia time (UTC+8) before adding a day, so the "tomorrow"
  // boundary lines up with the clinic's actual calendar day, not UTC's.
  const myt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  myt.setUTCDate(myt.getUTCDate() + 1);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dd = String(myt.getUTCDate()).padStart(2, "0");
  const mon = months[myt.getUTCMonth()];
  const yyyy = myt.getUTCFullYear();
  return `${dd}/${mon}/${yyyy}`;
}

// CRM gives "1530" (no colon). Board expects "15:30".
function toHHMM(raw) {
  const s = String(raw || "").padStart(4, "0");
  return s.slice(0, 2) + ":" + s.slice(2);
}

// Build a stable, collision-safe key so re-running the sync updates the same
// entry instead of duplicating it, and won't collide with walk-ins added
// manually on the board (those use numeric ids from Date.now()).
function crmKey(appt) {
  const safe = (v) => String(v || "").replace(/[.#$/\[\]]/g, "_");
  return `crm-${safe(appt.customerID)}-${safe(appt.StartDate)}-${safe(appt.StartTime)}`;
}

// Statuses that mean "this appointment is not happening" — excluded from the
// board. DELETED was the only one handled before, which is why CANCELLED rows
// were still showing up.
// TODO(confirm-with-CRM-sample): these are the expected spellings; verify the
// exact Status strings your CRM emits (cancelled / no-show) and adjust.
const DROP_STATUSES = new Set([
  "DELETED", "CANCELLED", "CANCELED", "NOSHOW", "NO SHOW", "NO-SHOW",
]);
function isDropped(appt) {
  return DROP_STATUSES.has(String(appt.Status || "").toUpperCase().trim());
}

// Pull the doctor name. Some rows come through blank because the doctor isn't
// always in ResourceName, or doesn't start with "DR".
// TODO(confirm-with-CRM-sample): confirm which column actually holds the
// doctor (ResourceName? DoctorName? StaffName?) and set it here — this is the
// second half of the "appointments without doctor names" fix.
function pickDoctor(appt) {
  const r = appt.ResourceName || "";
  return /^\s*DR/i.test(r) ? r.trim() : "";
}

// Per request, the board only pulls four fields: appointment DATE, TIME,
// customer name, doctor name. Treatment/service is intentionally NOT synced.

// v2 boards (SS2, GL) read a sectioned schema; the item id MUST equal the
// Firebase key it's written under, so actions write back to the same node.
function toV2Item(appt) {
  return {
    id: crmKey(appt), // MUST match the Firebase key this is written under (see main())
    source: "crm",    // lets the board's reset spare synced appointments
    customer: appt.CustomerName || "",
    doctor: pickDoctor(appt),
    therapist: "",
    treatment: [],
    appt: toHHMM(appt.StartTime),
    apptDate: appt.StartDate || "", // item 4: the date this appointment is for
    arrivedAt: "",
    consult: false,
    consultant: "",
  };
}

// v1 boards (RU, MA, SU, BM) read a single stringified JSON blob and render
// `onclick="fn(${id})"` UNQUOTED — so their ids must be NUMBERS, not the
// "crm-..." string key, or every button on a synced card is invalid JS.
function toV1Item(appt, idNum) {
  return {
    id: idNum,
    customer: appt.CustomerName || "",
    doctor: pickDoctor(appt),
    therapist: "",
    treatment: [],
    appt: toHHMM(appt.StartTime),
    apptDate: appt.StartDate || "",
    arrivedAt: "",
  };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const token = process.env.CRM_TOKEN;
  if (!token) throw new Error("CRM_TOKEN environment variable is not set");

  console.log("Fetching CRM appointment feed...");
  const username = process.env.CRM_USERNAME;
  const password = process.env.CRM_PASSWORD;
  if (!username || !password) throw new Error("CRM_USERNAME / CRM_PASSWORD environment variables are not set");
  const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

  const res = await fetch(token, {
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!res.ok) throw new Error(`CRM fetch failed: ${res.status} ${res.statusText}`);
  const all = await (async () => {
    const text = await res.text();
    const expectedLen = res.headers.get("content-length");
    if (expectedLen && Number(expectedLen) !== Buffer.byteLength(text)) {
      console.error(`WARNING: response may be truncated \u2014 server said Content-Length: ${expectedLen} bytes, but we received ${Buffer.byteLength(text)} bytes.`);
    } else if (expectedLen) {
      console.error(`Response length matches Content-Length header (${expectedLen} bytes) \u2014 not truncated.`);
    } else {
      console.error("No Content-Length header provided by server \u2014 cannot confirm the response wasn't truncated. Received", Buffer.byteLength(text), "bytes.");
    }
    const quoteCount = (text.match(/"/g) || []).length;
    console.error(`Total " characters in response: ${quoteCount} (${quoteCount % 2 === 0 ? "even \u2014 quotes balance" : "ODD \u2014 an unclosed quote exists somewhere, consistent with truncation or a genuine data error"})`);
    console.error("Last 60 chars of response:", JSON.stringify(text.slice(-60)));
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("csv") || text.trimStart().startsWith('"')) {
      // Server sends CSV (quoted, comma-separated), not JSON as originally
      // described. `columns: true` turns each row into an object keyed by
      // the header row, so every field name downstream stays the same as
      // if it had come from JSON.
      const { parse } = require("csv-parse/sync");
      try {
        // Keep REAL quote handling (so commas inside quoted fields don't split
        // columns) but SKIP the few malformed records instead of giving up on
        // the whole file. This is what stops one stray quote from forcing the
        // crude comma-splitter that misaligned every comma-containing row.
        return parse(text, {
          columns: true,
          skip_empty_lines: true,
          relax_quotes: true,
          relax_column_count: true,
          skip_records_with_error: true, // drop only the broken rows, stay aligned
          bom: true,
        });
      } catch (parseErr) {
        console.error("Resilient CSV parse still threw:", parseErr.code || parseErr.message);
        console.error("Retrying with quote handling disabled (last resort — may misalign)...");
        try {
          // WARNING: this treats " as a plain character and splits only on
          // commas. Any field that legitimately contains a comma (e.g. a
          // Description with one) will get mis-split into extra columns for
          // that row only — other rows are unaffected. This is a safety net
          // to keep the daily sync running despite bad source data, not a
          // real fix. If this branch keeps firing, the CRM export itself
          // has a data-quality problem worth reporting to the vendor.
          const rawRows = parse(text, {
            columns: true,
            skip_empty_lines: true,
            quote: null,
            relax_column_count: true,
          });
          // quote:null leaves literal " characters on every field, including
          // the header row (so column keys came out as `"StartDate"` instead
          // of `StartDate`, silently breaking every field lookup downstream).
          // Strip a leading/trailing " from every key and value to fix this.
          const stripQuotes = (s) =>
            typeof s === "string" ? s.replace(/^"|"$/g, "") : s;
          const rows = rawRows.map((row) => {
            const clean = {};
            for (const [k, v] of Object.entries(row)) {
              clean[stripQuotes(k)] = stripQuotes(v);
            }
            return clean;
          });
          console.error(`Fallback parse succeeded: ${rows.length} rows (some rows may have misaligned columns \u2014 see warning above)`);
          return rows;
        } catch (fallbackErr) {
          console.error("Fallback parse also failed. Diagnostic info:");
          console.error("  Response length:", text.length, "characters");
          console.error("  First 40 chars:", JSON.stringify(text.slice(0, 40)));
          throw fallbackErr;
        }
      }
    }
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      console.error("Response was neither CSV nor valid JSON. Diagnostic info:");
      console.error("  HTTP status:", res.status);
      console.error("  Content-Type:", contentType);
      console.error("  Response length:", text.length, "characters");
      console.error("  First 40 chars:", JSON.stringify(text.slice(0, 40)));
      throw parseErr;
    }
  })();

  const targetDate = process.env.TARGET_DATE || tomorrowCrmDateString();
  if (process.env.TARGET_DATE) {
    console.log(`Using manually specified date override: ${targetDate} (instead of tomorrow)`);
  }
  console.log(`Filtering for StartDate = ${targetDate}`);

  // ======================= TEMPORARY DIAGNOSTIC =======================
  // Prints the real CRM column names, and the distinct values of every
  // LOW-cardinality column (Status, Branch, Resource, etc.). High-cardinality
  // columns like customer name / phone are skipped, so no personal data is
  // logged. Paste the "CRM COLUMNS" + "distinct" lines back to finalize the
  // field mapping, then DELETE this whole block.
  {
    const keys = all.length ? Object.keys(all[0]) : [];
    console.log("CRM COLUMNS:", JSON.stringify(keys));
    console.log(`Parsed rows: ${all.length}`);
    // Categorical columns that are safe to print in full — resource/status/
    // branch codes, not personal data. If a CLEAN parse worked these are
    // small; if any is still huge, columns are still misaligning.
    const CATEGORICAL = ["customerType", "Status", "BranchID", "ResourceName"];
    for (const k of CATEGORICAL) {
      if (!keys.includes(k)) continue;
      const vals = [...new Set(all.map((r) => (r[k] == null ? "" : String(r[k]).trim())))].sort();
      const shown = vals.length <= 200 ? vals : vals.slice(0, 200);
      console.log(`  ${k}: ${vals.length} distinct${vals.length > 200 ? " (first 200)" : ""} => ${JSON.stringify(shown)}`);
    }
    // What real rows for the target date look like (customer name masked, so no
    // personal data is printed) — confirms which column holds the doctor and
    // how a cancelled row is marked.
    const mask = (s) => { s = String(s || ""); return s ? s[0] + "***" : ""; };
    const onDate = all.filter((r) => r.StartDate === targetDate);
    console.log(`Rows with StartDate=${targetDate}: ${onDate.length}`);
    console.log("Sample rows for that date [CustomerName masked]:");
    onDate.slice(0, 15).forEach((r, i) => {
      console.log(`  #${i} ` + JSON.stringify({
        ResourceName: r.ResourceName, Status: r.Status, BranchID: r.BranchID,
        StartTime: r.StartTime, EndTime: r.EndTime, customerType: r.customerType,
        CustomerName: mask(r.CustomerName),
      }));
    });
  }
  // ===================== END TEMPORARY DIAGNOSTIC =====================

  // READ-ONLY diagnostic build: stop here, before clearing or writing ANY
  // board. This lets you run the Action safely during clinic hours just to
  // collect the log above. Remove this block (and the diagnostic above) for
  // the real sync once the field mapping is confirmed.
  console.log("DIAGNOSTIC BUILD — no board was cleared or written. Paste the CRM COLUMNS / distinct lines above to finalize.");
  return;

  const kept = all.filter(
    (a) => !isDropped(a) && a.StartDate === targetDate
  );
  console.log(`${all.length} total rows -> ${kept.length} after filtering`);

  if (kept.length === 0) {
    // Zero matches is suspicious given a real appointment for this exact
    // date was confirmed to exist in the CRM. Two different explanations
    // are possible and need to be told apart:
    //  1. The fallback (comma-split) parser misaligned columns, so
    //     StartDate values are garbage / shifted from their real column.
    //  2. This report is genuinely historical and doesn't contain
    //     tomorrow's date at all, no matter how the file is parsed.
    const allDates = all.map((a) => a.StartDate).filter(Boolean);
    const uniqueDates = [...new Set(allDates)];
    console.log(`DIAGNOSTIC: ${uniqueDates.length} distinct StartDate values found in the whole file.`);
    console.log("DIAGNOSTIC: sample of 10 distinct StartDate values:", uniqueDates.slice(0, 10));
    const looksLike2026 = uniqueDates.filter((d) => /2026/.test(d));
    console.log(`DIAGNOSTIC: of those, ${looksLike2026.length} contain "2026" anywhere. Examples:`, looksLike2026.slice(0, 10));
  }

  // Group by branch
  const byBranch = {};
  for (const appt of kept) {
    const code = appt.BranchID;
    if (!BRANCHES[code]) continue; // ignore branches we don't manage boards for
    (byBranch[code] = byBranch[code] || []).push(appt);
  }

  // Write each branch to its own Firebase project
  for (const [code, branchCfg] of Object.entries(BRANCHES)) {
    const appts = byBranch[code] || [];
    const secretName = `FIREBASE_SA_${code}`;
    const saJson = process.env[secretName];
    if (!saJson) {
      console.warn(`Skipping ${code}: ${secretName} is not set yet`);
      continue;
    }

    const serviceAccount = JSON.parse(saJson);
    const app = admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        databaseURL: branchCfg.dbURL,
      },
      code // unique app name per branch, since we're doing several in one run
    );

    if (branchCfg.schema === "v2") {
      // Sectioned schema (SS2, GL). Clean slate every night (item 5):
      // clear rooms, queue, completed, removed. `board_v2/lists` (doctors,
      // therapists, treatments, room layout) lives on its own separate
      // node and is never touched, so the lists survive.
      await app.database().ref("board_v2").update({
        occ: null,
        queue: null,
        completed: null,
        removed: null,
        syncDate: targetDate, // item 4: board shows "Appointments for <date>"
      });
      console.log(`${code}: cleared rooms/queue/completed/removed (v2)`);

      const updates = {};
      for (const appt of appts) updates[crmKey(appt)] = toV2Item(appt);
      if (Object.keys(updates).length) {
        await app.database().ref("board_v2/queue").update(updates);
        console.log(`${code}: wrote ${Object.keys(updates).length} appointment(s)`);
      } else {
        console.log(`${code}: nothing to write for ${targetDate}`);
      }
    } else {
      // v1: the board stores its ENTIRE state as one JSON *string* at path
      // "board", and its listener only reacts when the value is a string
      // (`typeof v === "string"`). The previous version wrote a plain object
      // here, which every v1 board silently ignored — that's why only SS2
      // (v2) ever showed appointments.
      //
      // Fix: read the current string blob, parse it, replace ONLY the
      // transient keys (rooms/queue/completed/removed) + stamp the date,
      // keep everything else (doctor/therapist/treatment/room lists), and
      // write it back AS A STRING. Queue is an ARRAY with NUMERIC ids, which
      // is exactly what the v1 board expects.
      const snapshot = await app.database().ref("board").once("value");
      const raw = snapshot.val();
      let existing = {};
      if (typeof raw === "string") {
        try { existing = JSON.parse(raw); } catch (e) { existing = {}; }
      } else if (raw && typeof raw === "object") {
        existing = raw; // tolerate a legacy object blob
      }

      // Rebuild an empty occupancy map for whatever rooms the board has.
      const occ = {};
      (existing.groups || []).forEach((g) =>
        (g.rooms || []).forEach((r) => { occ[r] = null; })
      );

      // Numeric ids from a high base so they never collide with the small
      // sequential ids the board hands to manually-added walk-ins.
      const ID_BASE = 1000000000000;
      const queueArr = appts.map((appt, i) => toV1Item(appt, ID_BASE + i));

      const newState = {
        ...existing,
        occ,
        queue: queueArr,
        completed: [],
        removed: [],
        syncDate: targetDate, // item 4
        seq: Math.max(existing.seq || 1, ID_BASE + appts.length + 1),
      };

      await app.database().ref("board").set(JSON.stringify(newState)); // MUST be a string
      console.log(`${code}: cleared board and wrote ${queueArr.length} appointment(s) (v1)`);
    }

    await app.delete(); // clean up before initializing the next branch's app
  }

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
