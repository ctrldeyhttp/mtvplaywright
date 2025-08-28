// reset.js
import { resetSheet } from "./googlesheethelper.js";

(async () => {
  try {
    console.log("⏳ Resetting sheet...");
    await resetSheet();
    console.log("✅ Sheet reset complete");
    process.exit(0);
  } catch (err) {
    console.error("❌ Reset failed:", err);
    process.exit(1);
  }
})();
