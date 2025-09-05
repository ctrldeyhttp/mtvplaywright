import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { getNextEmail, releaseEmail, markVotingResults, getRemainingEmailsCount, updateDailySummary } from "./supabaseHelper";

// ⬇️ put this near the top of the file (after imports)
function getPHHour(): number {
  // Use Node’s built-in Intl to read Asia/Manila local hour
  const hourStr = new Intl.DateTimeFormat('en-PH', {
    hour: '2-digit',
    hour12: false,
    timeZone: 'Asia/Manila',
  }).format(new Date());             // e.g. "01"
  return parseInt(hourStr, 10);      // -> 1
}

async function detectQuotaForCategory(page: Page, categoryName: string): Promise<number | null> {
  const slug = categoryName.toLowerCase().replace(/\s+/g, '-');
  // button text often contains "10/10 votes remaining" or "20/20 votes remaining"
  let locator = page.locator(`#accordion-button-${slug}`);
  if (!(await locator.count())) {
    locator = page.getByRole('button', { name: categoryName });
  }
  try {
    const text = (await locator.innerText()).trim();
    const m = text.match(/\b(\d+)\s*\/\s*\1\s*votes?\s*remaining\b/i);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return null; // unknown
}


async function processCategory(page: Page, categoryName: string): Promise<boolean> {
  const categoryButton = page.getByRole('button', { name: categoryName });

  // ✅ Pre-check: already voted?
  const alreadySubmitted = await categoryButton
    .getByText(/Votes Submitted/i, { exact: false })
    .isVisible()
    .catch(() => false);

  if (alreadySubmitted) {
    console.log(`⏭️ Skipping ${categoryName} (already marked as Votes Submitted)`);
    return false; // don’t vote again
  }

  console.log(`Casting votes for ${categoryName}...`);
  return true; // continue voting
}


async function verifyAllCategoriesVoted(
  page: Page,
  categories: { name: string; regexes: RegExp[]; scopedLabel?: RegExp }[],
  votes: number
) {
  console.log("🔎 Verifying that all categories show 'Votes Submitted'...");

  const results: Record<string, string> = {};
  const remainingRe = new RegExp(String.raw`\b${votes}\s*\/\s*${votes}\s*votes?\s*remaining\b`, "i");

  for (const category of categories) {
    const slug = category.name.toLowerCase().replace(/\s+/g, '-');
    let locator = page.locator(`#accordion-button-${slug}`);
    if (!(await locator.count())) {
      locator = page.getByRole('button', { name: category.name });
    }

    try {
      const text = (await locator.innerText()).trim();
      console.log(`${category.name}\n\n${text}`);

      if (/Votes Submitted/i.test(text)) {
        console.log(`✅ ${category.name}: Votes Submitted`);
        results[category.name] = "✅ Submitted";
      } else if (remainingRe.test(text)) {
        console.warn(`⚠️ ${category.name}: Votes not submitted (still ${votes}/${votes} remaining)`);
        results[category.name] = await forceReVote(page, category, votes);
        // After re-vote, re-check
        const reText = (await locator.innerText()).trim();
        if (/Votes Submitted/i.test(reText)) {
          console.log(`✅ ${category.name}: Successfully re-voted`);
          results[category.name] = "✅ Submitted (Recovered)";
        } else {
          console.warn(`❌ ${category.name}: Re-vote failed`);
          results[category.name] = "❌ Re-vote failed";
        }
      } else {
        console.warn(`⚠️ ${category.name}: No 'Votes Submitted' text found`);
        results[category.name] = "⚠️ Missing";
      }
    } catch {
      console.warn(`⚠️ ${category.name}: Verification error`);
      results[category.name] = "⚠️ Verification error";
    }
  }

  return results;
}


async function ensureLoggedIn(page, email: string, row: number): Promise<boolean> {
  const loginPrompt = page.getByRole('heading', { name: /Log in to cast your vote/i });

  // 1️⃣ Check if login prompt is visible
  if (!(await loginPrompt.isVisible().catch(() => false))) return true; // already logged in

  console.log('⚠️ Login prompt detected, attempting login...');

  try {
    // Fill in email and submit
    await page.getByRole('textbox', { name: 'Enter email address' }).fill(email, { timeout: 2000 });
    await page.getByRole('button', { name: 'Log In' }).click({ timeout: 2000 });

    // 2️⃣ Wait for either success, invalid email message, or timeout
    const result = await Promise.race([
      // Success: "Video of the Year" section visible
      page.getByRole('region', { name: /Video of the Year/i })
        .getByRole('img')
        .waitFor({ timeout: 8000 })
        .then(() => 'success')
        .catch(() => null),

      // Invalid email detected
      page.getByText(/could not find an account|invalid email/i)
        .waitFor({ timeout: 5000 })
        .then(() => 'invalid')
        .catch(() => null),

      // Timeout fallback
      page.waitForTimeout(8000).then(() => 'timeout'),
    ]);

    if (result === 'success') {
      console.log('✅ Logged in successfully');
      return true;
    }

    if (result === 'invalid') {
      console.warn(`❌ Invalid email detected: ${email}`);
    } else {
      console.warn(`⚠️ Login did not succeed in time for ${email}`);
    }

    // 3️⃣ Close login modal if present
    try {
      await page.getByRole('button', { name: 'Close' }).click({ timeout: 1000 });
      console.log('✅ Closed login prompt');
    } catch {
      console.log('⚠️ No Close button found on login prompt');
    }

    // 4️⃣ Release email in Google Sheet
    await releaseEmail(row);
    console.log(`✅ Released email: ${email}`);
    return false; // skip this account
  } catch (err) {
    console.error(`❌ Login attempt failed: ${err.message}`);
    await releaseEmail(row);
    return false;
  }
}


async function castVotesWithRecovery(
  page,
  categoryName: string,
  candidateRegexes: RegExp[],
  maxVotes = 20,
  scopedLabelRegex?: RegExp,
  maxRecoveryAttempts = 3,
  email?: string,
  row?: number
) {
  console.log(`Casting votes for ${categoryName}...`);

  let voteCount = 0;
  let recoveryAttempts = 0;
  const submitRegex = /Submit/i;

  const categoryButton = page.getByRole('button', { name: categoryName });

  const slug = categoryName.toLowerCase().replace(/\s+/g, '-');
  const categoryScope = scopedLabelRegex
    ? page.getByRole('region', { name: scopedLabelRegex })
    : page.locator(`#accordion-panel-${slug}`);


  console.log(
    scopedLabelRegex
      ? `Using scoped locator: ${scopedLabelRegex}`
      : `Using global locator for ${categoryName}`
  );

  for (let i = 0; i < maxVotes; i++) {

  // ✅ make sure still logged in
    const stillLoggedIn = await ensureLoggedIn(page, email, row);
    if (!stillLoggedIn) {
      console.warn(`⚠️ Skipping ${categoryName}, account invalid: ${email}`);
      return;
    }
    // --- early stop if submit prompt appears ---
    const submitReady = await categoryScope
      .getByRole('heading', { name: /You have distributed all/i })
      .isVisible()
      .catch(() => false);

    if (submitReady) {
      console.log(`Reached submit state early at vote #${i + 1}`);
      break;
    }

    let clicked = false;

    for (const regex of candidateRegexes) {
      try {
        await categoryScope
          .locator('div')
          .filter({ hasText: regex })
          .getByLabel('Add Vote')
          .click({ timeout: 2000 });
    
        voteCount++;
        console.log(`Vote #${voteCount} submitted for ${categoryName} (matched ${regex})`);
        clicked = true;
        recoveryAttempts = 0;
        break;
      } catch {
        // short wait + retry once
        await page.waitForTimeout(1000);
        try {
          await categoryScope
            .locator('div')
            .filter({ hasText: regex })
            .getByLabel('Add Vote')
            .click({ timeout: 2000 });
          voteCount++;
          console.log(`Vote #${voteCount} submitted for ${categoryName} after retry (matched ${regex})`);
          clicked = true;
          recoveryAttempts = 0;
          break;
        } catch {
          // still failed → try next regex
        }
      }
    }
    

    if (!clicked) {
      console.warn(`⚠️ Stuck on vote #${i + 1} for ${categoryName}`);

      // 1️⃣ Try submitting immediately (Scoped → Global → Close)
      const trySubmitOrClose = async () => {
        try {
          await categoryScope.getByRole('button', { name: submitRegex }).click({ timeout: 1000 });
          console.log(`Submitted ${categoryName} votes ✅ (stuck at #${i + 1}, scoped)`);
          return true;
        } catch {
          try {
            await page.getByRole('button', { name: submitRegex }).last().click({ timeout: 1000 });
            console.log(`Submitted ${categoryName} votes ✅ via global fallback (stuck at #${i + 1})`);
            return true;
          } catch {
            try {
              await page.getByRole('button', { name: 'Close' }).click({ timeout: 700 });
              console.log(`✅ Closed category "${categoryName}" after failed submit attempt`);
              return true;
            } catch {
              console.log(`⚠️ No Submit or Close available for ${categoryName}`);
              return false;
            }
          }
        }
      };

      if (await trySubmitOrClose()) return;

      // 2️⃣ Retry by re-clicking category
      if (recoveryAttempts < maxRecoveryAttempts) {
        try {
          await categoryButton.click();
          await page.waitForTimeout(1000);
          recoveryAttempts++;
          console.log(
            `🔄 Recovery attempt ${recoveryAttempts}/${maxRecoveryAttempts} for "${categoryName}"`
          );
          i--; // retry this same vote
          continue;
        } catch {
          console.warn(`Failed to click category "${categoryName}" during recovery`);
        }
      }

      // 3️⃣ Skip category if nothing worked
      console.warn(`❌ Skipping ${categoryName} after being stuck at vote #${i + 1}`);
      return;
    }
  }

  // === SUBMIT ===
  if (voteCount > 0) {
    let submitted = false;

    const maxSubmitRetries = 3;

    for (let attempt = 1; attempt <= maxSubmitRetries; attempt++) {
      try {
        // Try scoped first
        await categoryScope.getByRole('button', { name: submitRegex }).click({ timeout: 2000 });
        submitted = true;
        console.log(`Submitted ${categoryName} votes ✅ (${voteCount}/${maxVotes}, scoped, attempt ${attempt})`);
        break;
      } catch {
        try {
          // Then try global fallback
          await page.getByRole('button', { name: submitRegex }).last().click({ timeout: 2000 });
          submitted = true;
          console.log(`Submitted ${categoryName} votes ✅ via global fallback (${voteCount}/${maxVotes}, attempt ${attempt})`);
          break;
        } catch {
          console.warn(`⚠️ Submit button not found for ${categoryName}, retry ${attempt}/${maxSubmitRetries}...`);
          await page.waitForTimeout(1000); // wait a second before retry
        }
      }
    }
  
    if (!submitted) {
      throw new Error(`❌ Could not find Submit button for ${categoryName} after ${maxSubmitRetries} retries`);
    }

    // 🔁 Require confirmation banner with one retry
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await expect(
          page.getByRole('heading', { name: /You have distributed all/i })
        ).toBeVisible({ timeout: 5000 });
        console.log(`✅ Confirmation banner appeared for ${categoryName}`);
        break;
      } catch {
        if (attempt === 1) {
          console.warn(`⚠️ Banner not visible, retrying submit click for ${categoryName}`);
          await page.getByRole('button', { name: submitRegex }).last().click({ timeout: 2000 }).catch(() => {});
        } else {
          throw new Error(`❌ Confirmation banner never appeared for ${categoryName}`);
        }
      }
    }
  }
}
    




test('MTV Voting Automation', async ({ page }) => {

  test.setTimeout(21600000); 

  

  const categories = [
  {
    name: 'Video of the Year',
    regexes: [/^ROSÉ & Bruno MarsAPT\.?\d*Votes$/],
    scopedLabel: undefined
  },
  {
    name: 'Song of the Year',
    regexes: [/^ROSÉ & Bruno MarsAPT\.?\d*Votes$/],
    scopedLabel: undefined
  },
  {
    name: 'Best Collaboration',
    regexes: [/^ROSÉ & Bruno MarsAPT\.?\d*Votes$/],
    scopedLabel: /Best Collaboration/i
  },
  {
    name: 'Best Pop',
    regexes: [/^ROSÉ & Bruno MarsAPT\.?\d*Votes$/],
    scopedLabel: /Best Pop/i
  },
  {
    name: 'Best K-Pop',
    regexes: [/^JENNIElike JENNIE\d*Votes$/],
    scopedLabel: undefined
  }
];

while (true) {
  // === Get next available email from Google Sheets ===
  const next = await getNextEmail();
  if (!next) {
    console.log("✅ No more emails available!");
    break;
  }
  const { email, row } = next;
  

  console.log(`\n=== Starting voting session for: ${email} ===`);
  const currentHour = getPHHour();
  const votes = currentHour === 1 ? 20 : 10;
  console.log(`⏱️ Current hour (PHT): ${currentHour}h → using ${votes} votes per category`);


  try {

    // --- LOGIN FLOW ---
    const start = Date.now(); // ⏱️ Start timer
    console.log('Navigating to MTV Voting Page...');
    await page.goto('https://www.mtv.com/event/vma/vote/video-of-the-year');

    if (!(await ensureLoggedIn(page, email, row))) continue;


    const loginPrompt = page.getByRole('heading', { name: /Log in to cast your vote/i });

    const artistOfYear = page.getByRole('region', { name: /Artist of the Year/i });
    const videoOfYear = page.getByRole('region', { name: /Video of the Year/i });

    if (await artistOfYear.isVisible({ timeout: 5000 }).catch(() => false)) {
      await releaseEmail(row);

      try {
        await page.getByRole('button', { name: /Log Out/i }).click({ timeout: 2000 });
        console.log(`✅ Logged out ${email}`);
      } catch {
        console.warn(`⚠️ Could not log out ${email}, maybe already invalid`);
      }

      return;
    }

    // Otherwise, fall back to Video of the Year
    await expect(videoOfYear.getByRole('img')).toBeVisible({ timeout: 10000 });
    console.log('✅ Video of the Year section is visible');
    page.waitForTimeout(1000);

    console.log('Casting first vote for ROSÉ & Bruno Mars...');
    await page.locator('div').filter({ hasText: /^ROSÉ & Bruno MarsAPT\.0Votes$/ }).getByLabel('Add Vote').click();

    const stillLoggedIn = await ensureLoggedIn(page, email, row);
    if (!stillLoggedIn) {
      console.warn(`⚠️ Skipping account ${email}, login failed after first vote`);
      continue;
    }

    // --- CATEGORY LOOP ---
    for (const category of categories) {
      const shouldVote = await processCategory(page, category.name);
      if (!shouldVote) continue;
      try {
        await page.getByRole('button', { name: category.name }).click({ timeout: 2000 }).catch(() => {});

        const detected = await detectQuotaForCategory(page, category.name);
        const effectiveVotes = detected ?? (getPHHour() === 1 ? 20 : 10);


        await castVotesWithRecovery(
          page,
          category.name,
          category.regexes,
          effectiveVotes,
          category.scopedLabel,
          3,
          email,   // <-- pass these so ensureLoggedIn() has values
          row
        );
      } catch (err) {
        console.warn(`⚠️ Skipping category ${category.name} due to error: ${err.message}`);
      }
    }

    // -- VERIFY VOTES
    await page.waitForTimeout(1000); 
    const results = await verifyAllCategoriesVoted(page, categories, votes);

    // --- LOGOUT ---
    await expect(page.getByRole('button', { name: 'Log Out' })).toBeVisible();
    await page.getByRole('button', { name: 'Log Out' }).click();
    console.log(`Logged out for ${email} ✅`);

    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    // ✅ Mark email as used in Google Sheet
    await markVotingResults(row, results, `${elapsedSec}s`, votes);

    console.log(`✅ Marked ${email} as USED in Supabase`);


  } catch (err) {
    console.error(`❌ Error during session for ${email}: ${err.message}`);
    await releaseEmail(row); 
    // optional: reset row status from "RESERVED" back to empty here
  }
}
});

async function forceReVote(page, category, votes: number) {
  console.log(`🔄 Forcing re-vote for ${category.name}...`);
  const categoryButton = page.getByRole('button', { name: category.name });

  try {
    await categoryButton.click({ timeout: 2000 });
    const slug = category.name.toLowerCase().replace(/\s+/g, '-');
    await expect(page.locator(`#accordion-panel-${slug}`)).toBeVisible({ timeout: 3000 });
    console.log(`✅ Expanded panel for ${category.name}`);
  } catch {
    console.warn(`⚠️ Could not expand ${category.name}, retrying without expansion`);
  }

  try {
    await castVotesWithRecovery(
      page,
      category.name,
      category.regexes,
      votes,                 // ⬅️ use the dynamic votes (10 or 20)
      category.scopedLabel
    );
  } catch (err) {
    console.error(`❌ Re-vote failed inside castVotesWithRecovery: ${err.message}`);
  }

  const locator = page.getByRole('button', { name: category.name });
  const text = await locator.innerText();
  if (/Votes Submitted/i.test(text)) {
    console.log(`✅ ${category.name}: Re-vote succeeded`);
    return "✅ Submitted (Recovered)";
  } else {
    console.warn(`❌ ${category.name}: Still not submitted after re-vote`);
    return "❌ Re-vote failed";
  }
}
