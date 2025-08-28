import { google } from 'googleapis';

const spreadsheetId = '1ROBIsbJStYB6F-696hWsHcNgdHugBjOLsCuWy3kTkRQ'; // <-- your sheet ID
const sheetName = 'Sheet1';
const RESERVED_TIMEOUT_MIN = 10; // reclaim reserved after 10 mins

// Google Auth (using service account JSON)
const auth = new google.auth.GoogleAuth({
  keyFile: 'lunar-marker-469521-a9-7706c202bdf1.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

export async function updateDailySummary() {
  const client = await auth.getClient();

  // Get both logs and summary sections
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [`${sheetName}!A:K`, `${sheetName}!P:T`], // now include more columns for summary
  });

  const [logs, summary] = res.data.valueRanges || [];
  const rows = logs?.values || [];
  const summaryRows = summary?.values || [];

  if (rows.length <= 1) return;

  // Format PH date
  const todayStr = getVotingDayString();

  // Calculate emails used and total votes
  let emailsUsed = 0;
  let totalVotes = 0;

  for (let i = 1; i < rows.length; i++) {
    const [email, status, , , , , , , , , votes] = rows[i] || [];
    if (status && status.toUpperCase() === "USED") {
      emailsUsed++;
      if (votes) {
        totalVotes += Number(votes) || 0;
      }
    }
  }

  const bpCategories = totalVotes * 5;
  const allCategories = totalVotes * 7;

  // If header missing, write it
  if (!summaryRows[0] || summaryRows[0][0] !== "Date") {
    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId,
      range: `${sheetName}!P1:T1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          [
            "Date",
            "Emails Used",
            "Total Votes Submitted",
            "BP CATEGORIES (*5)",
            "ALL CATEGORIES (*7)"
          ]
        ]
      },
    });
  }

  // Find if today's row exists
  const todayIndex = summaryRows.findIndex((r) => r[0] === todayStr);

  if (todayIndex !== -1) {
    // Update today's row
    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId,
      range: `${sheetName}!P${todayIndex + 1}:T${todayIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[todayStr, emailsUsed, totalVotes, bpCategories, allCategories]],
      },
    });
    console.log(`📊 Updated summary for ${todayStr}`);
  } else {
    // Append a new row
    await sheets.spreadsheets.values.append({
      auth: client,
      spreadsheetId,
      range: `${sheetName}!P:T`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[todayStr, emailsUsed, totalVotes, bpCategories, allCategories]],
      },
    });
    console.log(`📊 Added new summary for ${todayStr}`);
  }
}

function getPHTimeISO(date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export async function markVotingResults(
  row: number,
  results: Record<string, string>,
  durationSec: string,  // elapsed time
  votesSubmitted: number // NEW: count of votes submitted
) {
  const client = await auth.getClient();

  const orderedResults = [
    results["Video of the Year"] || "",
    results["Song of the Year"] || "",
    results["Best Pop Artist"] || "",
    results["Best Collaboration"] || "",
    results["Best Pop"] || "",
    results["Best K-Pop"] || "",
    results["Best Long Form Video"] || "",
  ];

  await sheets.spreadsheets.values.update({
    auth: client,
    spreadsheetId,
    range: `${sheetName}!B${row}:K${row}`, // extended range to K
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        [
          "USED",
          durationSec + "s",   // ⏱ elapsed duration
          ...orderedResults,
          votesSubmitted        // new column K
        ],
      ],
    },
  });
}


async function maybeResetUsedAtNoon() {
  const now = new Date();
  if (now.getHours() == 12) {
    console.log("⏰ After 12pm — resetting USED emails...");
    await resetUsedAtNoon();
  }
}


/**
 * Grab the next available email, mark it as RESERVED,
 * and return { email, row } for Playwright worker.
 */
export async function getNextEmail() {
  // (Optional) reset USED at noon like in Sheets
  await maybeResetUsedAtNoon();

  // Fetch all rows ordered by id
  const { data: rows, error } = await supabase
    .from("emails")
    .select("id, email, status, reserved_at")
    .order("id", { ascending: true });

  if (error) throw error;
  if (!rows || rows.length === 0) return null;

  const now = Date.now();

  for (const row of rows) {
    const { id, email, status, reserved_at } = row;

    // 1. Skip USED
    if (status && status.toUpperCase() === "USED") continue;

    // 2. Skip RESERVED still fresh
    if (status && status.toUpperCase() === "RESERVED") {
      if (reserved_at) {
        const reservedAt = new Date(reserved_at).getTime();
        const diffMin = (now - reservedAt) / 60000;
        if (diffMin < RESERVED_TIMEOUT_MIN) continue; // still locked
      }
    }

    // 3. Reserve this row
    const { error: updErr } = await supabase
      .from("emails")
      .update({ status: "RESERVED", reserved_at: getPHTimeISO() })
      .eq("id", id);

    if (updErr) throw updErr;

    return { email, row: id };
  }

  return null;
}


/**
 * Release RESERVED if the worker crashes or fails.
 */
export async function releaseEmail(row: number) {
  const client = await auth.getClient();

  await sheets.spreadsheets.values.update({
    auth: client,
    spreadsheetId,
    range: `${sheetName}!B${row}:C${row}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [['', '']], // clear status + timestamp
    },
  });
}

export async function resetUsedAtNoon() {
  const client = await auth.getClient();

  // Get all rows (status col = B)
  const res = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId,
    range: `${sheetName}!A:C`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return;

  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();

  // Only trigger after 12:00
  if (hours >= 12 && minutes >= 0) {
    const updates: any[] = [];

    rows.forEach((row, i) => {
      if (i === 0) return; // skip header
      const status = row[1];
      if (status && status.toUpperCase() === 'USED') {
        updates.push({
          range: `${sheetName}!B${i + 1}:K${i + 1}`,
          values: [['', '']], // clear status + timestamp
        });
      }
    });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        auth: client,
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates,
        },
      });
      console.log(`♻️ Reset ${updates.length} USED rows at noon`);
    }
  }
}

/**
 * Count how many emails are still available (not USED, not RESERVED within timeout).
 */
export async function getRemainingEmailsCount() {
  const client = await auth.getClient();

  const rows = await fetchEmailRows(client);
  if (rows.length <= 1) return 0;

  const now = Date.now();
  let available = 0;

  for (let i = 1; i < rows.length; i++) {
    const [, status, timestamp] = rows[i] || [];

    if (!status) { 
      available++; // no status means free
      continue;
    }

    const s = status.toUpperCase();

    if (s === "USED") continue;

    if (s === "RESERVED" && timestamp) {
      const reservedAt = new Date(timestamp).getTime();
      const diffMin = (now - reservedAt) / 60000;
      if (diffMin < RESERVED_TIMEOUT_MIN) continue;
    }

    available++;
  }

  return available;
}

function getVotingDayString(): string {
  const now = getPHNow();

  // Extract Manila Y/M/D
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = now.getHours();

  let votingDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00+08:00`);

  if (hh < 12) {
    votingDate.setDate(votingDate.getDate() - 1);
  }

  return votingDate.toLocaleDateString("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

async function fetchEmailRows(client) {
  const res = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId,
    range: `${sheetName}!A:C`,
  });
  return res.data.values || [];
}

function getPHNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
}