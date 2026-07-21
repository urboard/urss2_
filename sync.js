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
  GL:  { dbURL: "https://urgreenlane-default-rtdb.firebaseio.com" },
  SS2: { dbURL: "https://urss2-8597b-default-rtdb.asia-southeast1.firebasedatabase.app" },
  RU:  { dbURL: "https://urru-f9b89-default-rtdb.asia-southeast1.firebasedatabase.app" },
  MA:  { dbURL: "https://urma-f8632-default-rtdb.asia-southeast1.firebasedatabase.app" },
  SU:  { dbURL: "https://ursu-44644-default-rtdb.asia-southeast1.firebasedatabase.app" },
  BM:  { dbURL: "https://urbm-d3279-default-rtdb.asia-southeast1.firebasedatabase.app" },
};

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

// Map one CRM appointment into the shape the board's queue items expect.
// NOTE: no confirmed "treatment"/service field name has been seen in the CRM
// feed yet — leaving it blank rather than guessing. Add the real field name
// here once known (one line).
function toQueueItem(appt) {
  return {
    customer: appt.CustomerName || "",
    doctor: appt.ResourceName || "",
    therapist: "",
    treatment: appt.Description ? [appt.Description] : [], // ASSUMPTION: Description holds the treatment/service name — confirm with a real (non-deleted) row before trusting this
    appt: toHHMM(appt.StartTime),
    arrivedAt: "",
    consult: false,
    consultant: "",
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
        return parse(text, {
          columns: true,
          skip_empty_lines: true,
          relax_quotes: true, // tolerate a stray unescaped " inside a field instead of treating it as an open quote that swallows the rest of the file
          relax_column_count: true, // tolerate rows with an unexpected number of columns rather than throwing
        });
      } catch (parseErr) {
        console.error("Tolerant CSV parse still failed:", parseErr.code || parseErr.message);
        console.error("Retrying with quote handling disabled (last resort)...");
        try {
          // WARNING: this treats " as a plain character and splits only on
          // commas. Any field that legitimately contains a comma (e.g. a
          // Description with one) will get mis-split into extra columns for
          // that row only — other rows are unaffected. This is a safety net
          // to keep the daily sync running despite bad source data, not a
          // real fix. If this branch keeps firing, the CRM export itself
          // has a data-quality problem worth reporting to the vendor.
          const rows = parse(text, {
            columns: true,
            skip_empty_lines: true,
            quote: null,
            relax_column_count: true,
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

  const targetDate = tomorrowCrmDateString();
  console.log(`Filtering for StartDate = ${targetDate}`);

  const kept = all.filter(
    (a) => a.Status !== "DELETED" && a.StartDate === targetDate
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

    const updates = {};
    for (const appt of appts) {
      updates[crmKey(appt)] = toQueueItem(appt);
    }

    if (Object.keys(updates).length) {
      await app.database().ref("board_v2/queue").update(updates);
      console.log(`${code}: wrote ${Object.keys(updates).length} appointment(s)`);
    } else {
      console.log(`${code}: nothing to write for ${targetDate}`);
    }

    await app.delete(); // clean up before initializing the next branch's app
  }

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
