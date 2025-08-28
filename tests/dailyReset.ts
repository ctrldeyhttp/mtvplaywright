import { google } from "googleapis";
import path from "path";

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets("v4");
const spreadsheetId = "1ROBIsbJStYB6F-696hWsHcNgdHugBjOLsCuWy3kTkRQ";
const sheetName = "Sheet1";
const summarySheet = "Summary";

// ✅ Log daily total votes into Summary sheet
async function logDailyTotalVotes() {
  const client = await auth.getClient();

  // Fetch all rows including categories + votes
  const res = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId,
    range: `${sheetName}!A:O`, // includes categories + votes col + new O
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return;

  let dailyTotal = 0;
  const updates: any[] = [];

  // Process each email row
  rows.forEach((row, i) => {
    if (i === 0) return; // skip header row

    const votesPerCategory = parseInt(row[10] || "0", 10); // col K
    const categories = row.slice(3, 10); // cols D–J (7 categories)
    const submittedCount = categories.filter((c) =>
      (c || "").toLowerCase().includes("submitted")
    ).length;

    const totalVotes = votesPerCategory * submittedCount;
    dailyTotal += totalVotes;

    // Write per-email total into col O
    updates.push({
      range: `${sheetName}!O${i + 1}`,
      values: [[totalVotes]],
    });
  });

  // Batch update column O
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      auth: await auth.getClient(),
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });
    console.log(`📝 Updated per-email totals in column O`);
  }

  // Append daily summary (date + total)
  const phDate = new Date().toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  await sheets.spreadsheets.values.append({
    auth: client,
    spreadsheetId,
    range: `${summarySheet}!P:R`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[phDate, rows.length - 1, dailyTotal]], // date | #emails | total votes
    },
  });

  console.log(`📊 Logged daily total: ${dailyTotal} votes for ${phDate}`);
}

// ♻️ Reset Sheet1 (status + categories + votes per category, but keep emails)
async function resetSheetAtNoon() {
  const client = await auth.getClient();

  const res = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId,
    range: `${sheetName}!A:O`,
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return;

  const updates: any[] = [];

  rows.forEach((row, i) => {
    if (i === 0) return; // skip header
    // Reset cols B–O except email
    updates.push({
      range: `${sheetName}!B${i + 1}:O${i + 1}`,
      values: [["", "", "", "", "", "", "", "", "", "", "", "", "", ""]],
    });
  });

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      auth: client,
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });
    console.log(`♻️ Reset ${updates.length} rows`);
  }
}

// 🏃 Main
(async () => {
  await logDailyTotalVotes();
  await resetSheetAtNoon();
})();
