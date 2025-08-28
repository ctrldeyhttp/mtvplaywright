import fs from "fs";
import readline from "readline";

async function cleanCSV(inputFile, outputFile) {
  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile),
    crlfDelay: Infinity,
  });

  const out = fs.createWriteStream(outputFile);
  out.write("email,status\n");

  const seen = new Set();

  for await (const line of rl) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    const email = parts[0]?.trim();
    let status = parts[1]?.trim().toUpperCase();

    if (!email || email.toLowerCase() === "email") continue; // skip header
    if (seen.has(email)) continue; // skip duplicates
    seen.add(email);

    // ✅ Only allow RESERVED / USED / NULL
    if (status !== "USED" && status !== "RESERVED") status = "";

    out.write(`${email},${status}\n`);
  }
  out.end();
}

// Run with: node clean.js
cleanCSV(
  "/Users/daniel/Downloads/12345.csv",
  "/Users/daniel/Downloads/12345-cleaner.csv"
);
