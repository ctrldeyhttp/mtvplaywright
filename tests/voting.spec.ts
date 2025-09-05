import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { getNextEmail, releaseEmail, markVotingResults, getRemainingEmailsCount, updateDailySummary } from "./supabaseHelper";
const FIXED_VOTES = 20;


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
  page: Page,
  categoryName: string,
  candidateRegexes: RegExp[],
  maxVotes = 20,
  scopedLabelRegex?: RegExp,
  maxRecoveryAttempts = 3,
  email?: string,
  row?: number
) {
  console.log(`Casting votes for ${categoryName}...`);

  const submitRegex = /Submit/i;
  const slug = categoryName.toLowerCase().replace(/\s+/g, '-');

  const categoryButton = page.getByRole('button', { name: categoryName });
  const categoryScope = scopedLabelRegex
    ? page.getByRole('region', { name: scopedLabelRegex })
    : page.locator(`#accordion-panel-${slug}`);

  const bannerRe = new RegExp(`You have distributed all\\s+${maxVotes}\\s+votes`, 'i');
  const banner = page.getByText(bannerRe);

  let recoveryAttempts = 0;
  let clicksTried = 0;
  const MAX_EXTRA_TRIES = maxVotes * 2; // safety cap (e.g., 40 total attempts)

  // If the panel isn’t open yet, try to open it
  try {
    await expect(categoryScope).toBeVisible({ timeout: 2000 });
  } catch {
    try {
      await categoryButton.click();
      await expect(categoryScope).toBeVisible({ timeout: 3000 });
    } catch {
      console.warn(`⚠️ Could not expand "${categoryName}" panel`);
    }
  }

  // ⏳ Keep clicking until the banner appears (or we exhaust attempts)
  while (!(await banner.isVisible().catch(() => false)) && clicksTried < MAX_EXTRA_TRIES) {
    // ✅ still logged in?
    const stillLoggedIn = await ensureLoggedIn(page, email!, row!);
    if (!stillLoggedIn) {
      console.warn(`⚠️ Skipping ${categoryName}, account invalid: ${email}`);
      return;
    }

    // 🔎 try each candidate regex this iteration
    let clickedThisRound = false;
    for (const regex of candidateRegexes) {
      try {
        await categoryScope
          .locator('div')
          .filter({ hasText: regex })
          .getByLabel('Add Vote')
          .click({ timeout: 2000 });

        clicksTried++;
        clickedThisRound = true;
        console.log(`Click ${clicksTried}: ${categoryName} (matched ${regex})`);

        await expect(
          categoryScope.getByText(/Votes?\s*remaining|Votes?\s*Submitted/i).first()
        ).toBeVisible({ timeout: 500 });


        // re-check banner immediately
        if (await banner.isVisible().catch(() => false)) break;
      } catch {
        // try next regex
      }
    }

    if (!clickedThisRound) {
      console.warn(`⚠️ Couldn’t click any candidate this round for "${categoryName}"`);

      // Try quick submit-or-close (your existing pattern)
      const trySubmitOrClose = async () => {
        try {
          await categoryScope.getByRole('button', { name: submitRegex }).click({ timeout: 800 });
          console.log(`Submitted ${categoryName} (fallback while stuck)`);
          return true;
        } catch {
          try {
            await page.getByRole('button', { name: submitRegex }).last().click({ timeout: 800 });
            console.log(`Submitted ${categoryName} (global fallback while stuck)`);
            return true;
          } catch {
            try {
              await page.getByRole('button', { name: 'Close' }).click({ timeout: 700 });
              console.log(`Closed "${categoryName}" after failed submit attempt`);
              return false;
            } catch {
              return false;
            }
          }
        }
      };

      if (await trySubmitOrClose()) return;

      // Try re-expanding the category a few times
      if (recoveryAttempts < maxRecoveryAttempts) {
        try {
          await categoryButton.click();
          await page.waitForTimeout(1000);
          recoveryAttempts++;
          console.log(`🔄 Recovery attempt ${recoveryAttempts}/${maxRecoveryAttempts} for "${categoryName}"`);
          continue; // loop and try clicks again
        } catch {
          console.warn(`⚠️ Couldn’t re-click category "${categoryName}"`);
        }
      }

      // Give up if nothing worked
      console.warn(`❌ Skipping ${categoryName}: can’t progress to banner`);
      return;
    }
  }

  // ✅ At this point we either saw the banner or hit the cap
  if (!(await banner.isVisible().catch(() => false))) {
    console.warn(`⚠️ Never saw the "all ${maxVotes}" banner for ${categoryName} after ${clicksTried} attempts`);
  } else {
    console.log(`✅ UI confirms all ${maxVotes} votes distributed for ${categoryName}`);
  }

  // === SUBMIT ===
  let submitted = false;
  const maxSubmitRetries = 3;

  for (let attempt = 1; attempt <= maxSubmitRetries; attempt++) {
    try {
      await categoryScope.getByRole('button', { name: submitRegex }).click({ timeout: 1000 });
      submitted = true;
      console.log(`Submitted ${categoryName} ✅ (attempt ${attempt})`);
      break;
    } catch {
      try {
        await page.getByRole('button', { name: submitRegex }).last().click({ timeout: 1000 });
        submitted = true;
        console.log(`Submitted ${categoryName} ✅ via global fallback (attempt ${attempt})`);
        break;
      } catch {
        console.warn(`⚠️ Submit not found for ${categoryName}, retry ${attempt}/${maxSubmitRetries}...`);
        await page.waitForTimeout(1000);
      }
    }
  }

  if (!submitted) throw new Error(`❌ Could not find Submit for ${categoryName}`);

  // Final confirmation (your existing banner check)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await expect(page.getByRole('heading', { name: /You have distributed all/i }))
        .toBeVisible({ timeout: 5000 });
      console.log(`✅ Confirmation banner appeared for ${categoryName} (post-submit)`);
      break;
    } catch {
      if (attempt === 1) {
        console.warn(`⚠️ Post-submit banner not visible, retrying submit click for ${categoryName}`);
        await page.getByRole('button', { name: submitRegex }).last().click({ timeout: 2000 }).catch(() => {});
      } else {
        console.warn(`⚠️ Post-submit confirmation didn’t appear for ${categoryName}`);
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


console.log('Navigating to MTV Voting Page...');
await page.goto('https://www.mtv.com/event/vma/vote/video-of-the-year');

while (true) {
  // === Get next available email from Google Sheets ===
  const next = await getNextEmail();
  if (!next) {
    console.log("✅ No more emails available!");
    break;
  }
  const { email, row } = next;
  

  console.log(`\n=== Starting voting session for: ${email} ===`);
  const votes = FIXED_VOTES;
  console.log(`⏱️ Forcing ${votes} votes per category (ignoring time)`);


  try {

    // --- LOGIN FLOW ---
    const start = Date.now(); // ⏱️ Start timer

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

        const effectiveVotes = FIXED_VOTES;


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
      FIXED_VOTES,                 // ⬅️ use the dynamic votes (10 or 20)
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