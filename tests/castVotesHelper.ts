import { expect, Page } from '@playwright/test';

export async function castVotesWithRecovery(
  page: Page,
  categoryName: string,
  candidateRegexes: RegExp[],
  maxVotes = 10,
  scopedLabelRegex?: RegExp,
  maxRecoveryAttempts = 3
) {
  console.log(`Casting votes for ${categoryName}...`);

  let voteCount = 0;
  let recoveryAttempts = 0;

  const categoryButton = page.getByRole('button', { name: categoryName });
  const categoryScope = scopedLabelRegex
    ? page.getByRole('region', { name: scopedLabelRegex })
    : page;

  for (let i = 0; i < maxVotes; i++) {
    // stop early if already "Submit"-ready
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
          categoryScope.locator('div')
            .filter({ hasText: regex })
            .getByLabel('Add Vote')
            .click(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 3000))
        ]);
        voteCount++;
        console.log(`Vote #${voteCount} submitted for ${categoryName} (matched ${regex})`);
        clicked = true;
        recoveryAttempts = 0;
        break;
      } catch {
        // try next regex
      }
    }

    if (!clicked) {
      console.warn(`⚠️ Stuck on vote #${i + 1} for ${categoryName}`);

      // 1: try submit
      try {
        await categoryScope.getByRole('button', { name: 'Submit' }).click({ timeout: 1000 });
        console.log(`Submitted ${categoryName} votes ✅ (stuck at #${i + 1})`);
        return;
      } catch {}

      // 2: retry category click
      if (recoveryAttempts < maxRecoveryAttempts) {
        try {
          await categoryButton.click();
          await page.waitForTimeout(700);
          recoveryAttempts++;
          console.log(`🔄 Recovery attempt ${recoveryAttempts}/${maxRecoveryAttempts} for "${categoryName}"`);
          i--;
          continue;
        } catch {}
      }

      // 3: give up
      console.warn(`❌ Skipping ${categoryName} after being stuck at vote #${i + 1}`);
      return;
    }
  }

  // --- SUBMIT ---
  if (voteCount > 0) {
    let submitted = false;
    try {
      await categoryScope.getByRole('button', { name: 'Submit' }).click({ timeout: 2000 });
      submitted = true;
      console.log(`Submitted ${categoryName} votes ✅ (${voteCount}/${maxVotes})`);
    } catch {
      try {
        await page.getByRole('button', { name: 'Submit' }).last().click({ timeout: 2000 });
        submitted = true;
        console.log(`Submitted ${categoryName} votes ✅ via fallback`);
      } catch {
        console.warn(`❌ Failed to find ANY Submit for ${categoryName}`);
      }
    }

    if (submitted) {
      await page.waitForTimeout(1000);
      const confirmed = await page
        .getByRole('heading', { name: /You have distributed all/i })
        .isVisible()
        .catch(() => false);
      if (!confirmed) {
        console.warn(`⚠️ Submitted ${categoryName}, but no confirmation banner`);
      }
    }
  } else {
    console.log(`Skipped ${categoryName} (no votes submitted) ❌`);
  }
}
