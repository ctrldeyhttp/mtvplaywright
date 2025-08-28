import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { getNextEmail, markEmailUsed, releaseEmail, markVotingResults} from "./googleSheetHelper";


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


async function verifyAllCategoriesVoted(page: Page, categories: string[]) {
  console.log("🔎 Verifying that all categories show 'Votes Submitted'...");

  const results: Record<string, string> = {};

  for (const category of categories) {
    const slug = category.toLowerCase().replace(/\s+/g, '-');
    let locator = page.locator(`#accordion-button-${slug}`);

    if (!(await locator.count())) {
      locator = page.getByRole('button', { name: category });
    }

    try {
      console.log(await locator.innerText());
      await expect(locator).toContainText(/Votes Submitted/i);
      console.log(`✅ ${category}: Votes Submitted`);
      results[category] = "✅ Submitted";
    } catch {
      console.warn(`⚠️ ${category}: No 'Votes Submitted' text found`);
      results[category] = "⚠️ Missing";
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
  maxVotes = 10,
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
  const categoryScope = scopedLabelRegex
    ? page.getByRole('region', { name: scopedLabelRegex })
    : page;

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
    const submitReady = await page
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
        await Promise.race([
          categoryScope
            .locator('div')
            .filter({ hasText: regex })
            .getByLabel('Add Vote')
            .click(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Click timeout')), 3000)
          )
        ]);

        voteCount++;
        console.log(
          `Vote #${voteCount} submitted for ${categoryName} (matched ${regex})`
        );
        clicked = true;
        recoveryAttempts = 0; // reset on success
        break;
      } catch {
        // try next regex
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
    name: 'Best Pop Artist',
    regexes: [/^Ariana Grande\d*Votes$/],
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
    scopedLabel: undefined
  },
  {
    name: 'Best K-Pop',
    regexes: [/^JENNIElike JENNIE\d*Votes$/],
    scopedLabel: undefined
  },
  {
    name: 'Best Long Form Video',
    regexes: [/^Ariana Grandebrighter days ahead\d*Votes$/],
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
  const votes = 10;

  try {
    // --- LOGIN FLOW ---
    const start = Date.now(); // ⏱️ Start timer
    console.log('Navigating to MTV Voting Page...');
    await page.goto('https://www.mtv.com/event/vma/vote/video-of-the-year');

    if (!(await ensureLoggedIn(page, email, row))) continue;


    const loginPrompt = page.getByRole('heading', { name: /Log in to cast your vote/i });

    const videoOfYear = page.getByRole('region', { name: /Video of the Year/i });
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
        await castVotesWithRecovery(
          page,
          category.name,
          category.regexes,
          votes,
          category.scopedLabel
        );
      } catch (err) {
        console.warn(`⚠️ Skipping category ${category.name} due to error: ${err.message}`);
      }
    }

    // -- VERIFY VOTES
    const results = await verifyAllCategoriesVoted(page, categories.map(c => c.name));
    

    // --- LOGOUT ---
    await expect(page.getByRole('button', { name: 'Log Out' })).toBeVisible();
    await page.getByRole('button', { name: 'Log Out' }).click();
    console.log(`Logged out for ${email} ✅`);

    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    // ✅ Mark email as used in Google Sheet
    await markVotingResults(row, results, `${elapsedSec}s`);
    console.log(`✅ Marked ${email} as USED in Google Sheet`);


  } catch (err) {
    console.error(`❌ Error during session for ${email}: ${err.message}`);
    await releaseEmail(row); 
    // optional: reset row status from "RESERVED" back to empty here
  }
}
});
