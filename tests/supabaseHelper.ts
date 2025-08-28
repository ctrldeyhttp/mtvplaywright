import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://skoiuepflwrlbkpaapza.supabase.co";
const supabaseKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrb2l1ZXBmbHdybGJrcGFhcHphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4Njc5ODksImV4cCI6MjA3MTQ0Mzk4OX0.-4jxmICyrk2EKc_JfsAqdTJ_SL3Cpfwwwqa9AagfkVQ"; // ⚠️ service_role key (keep private!)
const supabase = createClient(supabaseUrl, supabaseKey);

const RESERVED_TIMEOUT_MIN = 10;

function getPHNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC → Manila
}



// 🕒 Format Manila voting day string (same as your Sheet version)
function getVotingDayString(): string {
  const nowUTC = new Date();

  // Shift UTC → PH (UTC+8)
  const phNow = new Date(nowUTC.getTime() + 8 * 60 * 60 * 1000);

  // If before noon → use yesterday’s date
  if (phNow.getHours() < 12) {
    phNow.setDate(phNow.getDate() - 1);
  }

  // Format YYYY-MM-DD
  return phNow.toISOString().split("T")[0];
}


// 🕒 PH time helper
function getPHTimeISO(): string {
  const nowUTC = new Date();
  // add 8 hours (8 * 60 * 60 * 1000 ms)
  const phTime = new Date(nowUTC.getTime() + 8 * 60 * 60 * 1000);

  const pad = (n: number) => String(n).padStart(2, "0");
  const year = phTime.getUTCFullYear();
  const month = pad(phTime.getUTCMonth() + 1);
  const day = pad(phTime.getUTCDate());
  const hour = pad(phTime.getUTCHours());
  const min = pad(phTime.getUTCMinutes());
  const sec = pad(phTime.getUTCSeconds());

  return `${year}-${month}-${day}T${hour}:${min}:${sec}+08:00`;
}


/**
 * Grab the next available email, mark it as RESERVED, and return { email, row }.
 */
export async function getNextEmail() {
  const cutoff = new Date(Date.now() - RESERVED_TIMEOUT_MIN * 60000).toISOString();

  const { data, error } = await supabase.rpc("reserve_next_email", { cutoff });

  if (error) throw error;
  if (!data || data.length === 0) return null;

  return { email: data[0].reserved_email, row: data[0].reserved_id };
}



/**
 * Release RESERVED if the worker crashes.
 */
export async function releaseEmail(row: number) {
  const { error } = await supabase
    .from("emails")
    .update({ status: null, reserved_at: null })
    .eq("id", row);

  if (error) throw error;
}

/**
 * Mark results for a finished voting session.
 */
// supabaseHelper.ts

export async function markVotingResults(
  row: number,                          // emails.id
  results: Record<string, string>,      // from verifyAllCategoriesVoted
  durationSec: string,                  // e.g. "42.1s" or "42"
  votesSubmitted: number                // 10 or 20
) {
  // Map result labels to your column names
  const orderedResults = {
    result_video:       results["Video of the Year"]      ?? null,
    result_song:        results["Song of the Year"]       ?? null,
    result_pop_artist:  results["Best Pop Artist"]        ?? null,
    result_collab:      results["Best Collaboration"]     ?? null,
    result_pop:         results["Best Pop"]               ?? null,
    result_kpop:        results["Best K-Pop"]             ?? null,
    result_longform:    results["Best Long Form Video"]   ?? null,
  };

  // payload to update the row as USED
  const payload: any = {
    status: "USED",
    duration_sec: parseInt(String(durationSec).replace(/[^\d.-]/g, ""), 10) || null,
    votes_submitted: votesSubmitted,
    completed_at: new Date().toISOString(),   // <-- anchor the voting day on completion
    ...orderedResults,
  };

  const { error: updErr } = await supabase
    .from("emails")
    .update(payload)
    .eq("id", row);

  if (updErr) {
    console.error("❌ markVotingResults update failed:", updErr.message);
    throw updErr;
  }

  // (Optional) read back for debugging
  const { data: checkRow, error: readErr } = await supabase
    .from("emails")
    .select("id, status, votes_submitted, completed_at")
    .eq("id", row)
    .single();

  if (readErr) {
    console.warn("⚠️ markVotingResults read-back failed:", readErr.message);
  } else {
    console.log("🔎 Row after mark:", checkRow);
  }

  console.log(`✅ Marked row ${row} as USED with ${votesSubmitted} votes`);
}


function getPHDateOnly() {
  // Always get YYYY-MM-DD in Philippine time
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

export async function resetUsedAtNoon() {
  const todayStr = getPHDateOnly();

  // UPSERT ensures only 1 row per date
  const { error } = await supabase
    .from("daily_summary")
    .upsert(
      { date: todayStr, reset_done: true },
      { onConflict: "date" }
    );

  if (error) {
    console.error("Failed to upsert daily_summary:", error);
  } else {
    console.log(`✅ daily_summary updated for ${todayStr}`);
  }
}


/**
 * Count how many emails are still available.
 */
export async function getRemainingEmailsCount() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RESERVED_TIMEOUT_MIN * 60000).toISOString();

  // 1. Count UNUSED (status is NULL)
  const { count: unused, error: err1 } = await supabase
    .from("emails")
    .select("*", { count: "exact", head: true })
    .is("status", null);

  if (err1) throw err1;

  // 2. Count EXPIRED RESERVED
  const { count: expired, error: err2 } = await supabase
    .from("emails")
    .select("*", { count: "exact", head: true })
    .eq("status", "RESERVED")
    .lt("reserved_at", cutoff);

  if (err2) throw err2;

  return (unused || 0) + (expired || 0);
}

/**
 * Update or insert daily summary.
 */
export async function updateDailySummary() {
  // Today’s PH voting date string (YYYY-MM-DD, but day runs 12PM→12PM)
  const todayStr = getVotingDayString();

  // Compute PH start/end for this voting day
  const nowUTC = new Date();
  const phNow = new Date(nowUTC.getTime() + 8 * 60 * 60 * 1000);

  // If before noon PH, we’re still in “yesterday’s” voting day
  if (phNow.getHours() < 12) {
    phNow.setDate(phNow.getDate() - 1);
  }

  const start = new Date(phNow);
  start.setHours(12, 0, 0, 0); // 12:00 PM PH start

  const end = new Date(start);
  end.setDate(end.getDate() + 1); // +1 day → 12:00 PM next day

  // Convert PH start/end to UTC ISO for querying reserved_at (timestamptz)
  const startUTC = new Date(start.getTime() - 8 * 60 * 60 * 1000).toISOString();
  const endUTC = new Date(end.getTime() - 8 * 60 * 60 * 1000).toISOString();

  // === 1. Count USED emails for this voting day ===
  const { count: emailsUsed, error: countErr } = await supabase
    .from("emails")
    .select("*", { count: "exact", head: true })
    .eq("status", "USED")
    .gte("reserved_at", startUTC)
    .lt("reserved_at", endUTC);

  if (countErr) throw countErr;

  // === 2. Sum votes_submitted for this voting day ===
  const { data: voteRows, error: votesErr } = await supabase
    .from("emails")
    .select("votes_submitted")
    .eq("status", "USED")
    .gte("reserved_at", startUTC)
    .lt("reserved_at", endUTC);

  if (votesErr) throw votesErr;

  let totalVotes = 0;
  for (const row of voteRows || []) {
    totalVotes += row.votes_submitted || 0;
  }

  const bpCategories = totalVotes * 5;
  const allCategories = totalVotes * 7;

  // === 3. Upsert into daily_summary ===
  const { error: upsertErr } = await supabase
    .from("daily_summary")
    .upsert(
      {
        date: todayStr,
        emails_used: emailsUsed || 0,
        total_votes: totalVotes,
        bp_categories: bpCategories,
        all_categories: allCategories,
      },
      { onConflict: "date" }
    );

  if (upsertErr) throw upsertErr;
  console.log(`📊 Upserted daily summary for ${todayStr}`);
}

