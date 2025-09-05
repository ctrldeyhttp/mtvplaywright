import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 0,
  use: {
    headless: true, // ⬅️ run all headless
  },
  projects: [
    ...Array.from({ length: 1 }, (_, i) => ({
      name: `chromium-${i + 1}`,
      use: { ...devices['Desktop Chrome'] },
    }))
  ]
});
