const { spawn } = require("child_process");
const { getRemainingEmailsCount } = require("./tests/supabaseHelper.ts");
const programStartTime = Date.now();

// === Timeouts ===
const timeoutMs = 40000;       // step-stuck timeout
const noLogTimeoutMs = 40000;  // no logs timeout
const restartDelay = 2000;     // delay before restarting

// === Session state ===
let timer;
let heartbeat;
let lastOutput = Date.now();
let currentStep = 0;
let sessionCount = 0;
let sessionActive = false;
let sessionLogs = 0;
let sessionStartTime = null;
let currentEmail = "";

let latestLog = "";
let finishedBars = [];

let lastStep = 0;
let lastStepTime = Date.now();
let restarting = false;

// 📊 Global stats
let totalRuntimeMs = 0;
let totalFinished = 0;
let remainingEmails = "–";


// === UI Helpers ===
const MAX_WIDTH = 80;

function truncateEmail(email, maxLen = 20) {
  if (email.length <= maxLen) return email;
  const half = Math.floor((maxLen - 3) / 2);
  return email.slice(0, half) + "..." + email.slice(-half);
}

async function refreshRemainingEmails() {
  try {
    const count = await getRemainingEmailsCount();
    remainingEmails = count;
  } catch (err) {
    remainingEmails = "ERR";
    console.error("❌ Failed to fetch remaining emails:", err.message);
  }
}
setInterval(refreshRemainingEmails, 5000);
refreshRemainingEmails(); // initial fetch

const workerCount = 5; // adjust if dynamic later

function computeETA() {
  if (remainingEmails === "–" || remainingEmails === "ERR") return "–";
  if (totalFinished === 0) return "–"; // no data yet

  // use recent average if possible, else fallback to all-time
  const avgMs = finishedBars.length > 0
    ? finishedBars.reduce((a, b) => a + b.ms, 0) / finishedBars.length
    : totalRuntimeMs / totalFinished;

  // divide by workers since they process in parallel
  const etaMs = (avgMs * Number(remainingEmails)) / workerCount;
  return formatRuntime(etaMs);
}



function renderBar(step, total, forceComplete = false) {
  const reserved = 30;
  const width = Math.min(MAX_WIDTH - reserved, 40);

  let progress = forceComplete ? 1 : (total > 0 ? step / total : 0);
  progress = Math.max(0, Math.min(progress, 1));

  const filled = Math.min(width, Math.max(0, Math.round(progress * width)));
  const empty = Math.max(0, width - filled);

  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${Math.round(progress * 100)}%`;
}

function formatRuntime(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return min > 0 ? `${min}m ${s}s` : `${s}s`;
}

function averageRuntimeAll() {
  if (totalFinished === 0) return "–";
  return formatRuntime(totalRuntimeMs / totalFinished);
}

function averageRuntimeRecent() {
  if (finishedBars.length === 0) return "–";
  const sum = finishedBars.reduce((a, b) => a + b.ms, 0);
  return formatRuntime(sum / finishedBars.length);
}

function redrawAllBars(currentBar = null, logLine = "", runtime = "") {
  process.stdout.write("\x1b[2J\x1b[0f");

  console.log(`📊 Avg runtime (all sessions): ${averageRuntimeAll()}`);
  console.log(`📊 Avg runtime (last 5): ${averageRuntimeRecent()}`);
  console.log(`📦 Total finished: ${totalFinished}`);
  console.log(`📨 Remaining emails: ${remainingEmails}`);
  console.log(`⏳ ETA to finish: ${computeETA()}`);
  console.log(`⏱ Total runtime: ${formatRuntime(Date.now() - programStartTime)}\n`);

  for (let fb of finishedBars) {
    console.log(
      `📧 Session #${fb.num} ${fb.bar} ✅ Finished (${fb.runtime}) ${truncateEmail(fb.email)}`
    );
  }

  if (currentBar) {
    console.log(`📧 Session #${sessionCount} ${currentBar} ${truncateEmail(currentEmail)}`);
    if (logLine) console.log("↳ " + logLine);
    if (runtime) console.log(`⏱ Runtime: ${runtime}`);
  }
}

function updateDisplay(step, total, logLine, forceComplete = false) {
  const bar = renderBar(step, total, forceComplete);

  const maxWidth = MAX_WIDTH - bar.length - 10;
  let cleanLog = logLine.replace(/\s+/g, " ");
  if (cleanLog.length > maxWidth) {
    cleanLog = cleanLog.slice(0, maxWidth - 3) + "...";
  }

  if (forceComplete) {
    const ms = Date.now() - sessionStartTime;
    const runtime = formatRuntime(ms);

    finishedBars.push({ num: sessionCount, email: currentEmail, bar, runtime, ms });
    if (finishedBars.length > 5) {
      finishedBars.shift();
    }

    totalRuntimeMs += ms;
    totalFinished++;

    redrawAllBars();
  } else {
    latestLog = cleanLog;
    const runtime = sessionStartTime ? formatRuntime(Date.now() - sessionStartTime) : "";
    redrawAllBars(bar, latestLog, runtime);
  }
}

// === Restart Logic ===
function restart() {
  if (restarting) return;
  restarting = true;

  console.warn("🔄 Restarting session in 2s...");
  clearTimeout(timer);
  clearInterval(heartbeat);

  setTimeout(() => {
    restarting = false;
    start();
  }, restartDelay);
}

// === Main Runner ===
function start() {
  console.log("🚀 Starting Playwright script...");

  const child = spawn("npx", ["playwright", "test", "voting.spec.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  // === Add these near your session state ===
let sessionCompleted = false;
let recentLines = [];              // sliding window to dedupe
const RECENT_WINDOW = 50;          // keep last 50 lines
let lastStartEmail = "";
let lastStartAt = 0;

// Small helper: dedupe identical lines that arrive close together (stdout+stderr)
function seenRecently(line) {
  const now = Date.now();
  // prune old
  recentLines = recentLines.filter(x => now - x.t < 5000); // keep 5s
  if (recentLines.some(x => x.line === line)) return true;
  recentLines.push({ line, t: now });
  if (recentLines.length > RECENT_WINDOW) recentLines.shift();
  return false;
}

function handleOutput(data, source) {
  const text = data.toString();
  lastOutput = Date.now();

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 🚫 Skip duplicates that arrive from the other stream
    if (seenRecently(line)) continue;

    // ===== SESSION START =====
    if (line.includes("=== Starting voting session for:")) {
      const match = line.match(/for:\s*(\S+)/);
      const email = match ? match[1] : "unknown";

      // Guard: don't count the same start twice within a short window
      const now = Date.now();
      const isDupeStart =
        sessionActive &&
        email === currentEmail &&
        now - sessionStartTime < 3000; // 3s window

      if (!isDupeStart) {
        sessionCount++;
        sessionActive = true;
        sessionCompleted = false;
        sessionLogs = 0;
        currentStep = 0;
        sessionStartTime = now;
        lastStartEmail = email;
        lastStartAt = now;

        // 🟢 Reset stuck-check state for new session
        lastStep = 0;
        lastStepTime = now;

        currentEmail = email;

        if (sessionCount > 1 && (sessionCount - 1) % 5 === 0) {
          finishedBars = [];
          process.stdout.write("\x1b[2J\x1b[0f");
        }

        updateDisplay(0, 1, `Session #${sessionCount} started`);
      }
      continue;
    }

    // ===== SESSION COMPLETE =====
    if (line.includes("✅ Marked") || line.includes("as USED in Google Sheet")) {
      // Guard: only finish once
      if (!sessionCompleted) {
        sessionCompleted = true;
        updateDisplay(sessionLogs, sessionLogs, "✅ Session complete!", true);
        sessionActive = false;
        clearInterval(heartbeat);
      }
      continue;
    }

    // ===== PROGRESS =====
    if (sessionActive) {
      sessionLogs++;
      currentStep++;
      updateDisplay(currentStep, 170, line);
    }

    latestLog = line;
  }
}

// Wire the source label so we can dedupe effectively (optional but clean)
child.stdout.on("data", d => handleOutput(d, "stdout"));
child.stderr.on("data", d => handleOutput(d, "stderr"));


  function checkStuck() {
    const now = Date.now();
  
    // step progress watchdog
    if (currentStep > lastStep) {
      lastStep = currentStep;
      lastStepTime = now;
    }
  
    if (now - lastStepTime > timeoutMs) {
      console.warn("\n⚠️ No progress in steps → restarting...");
      child.kill("SIGINT");
      restart();
      return;
    }
  
    // no log watchdog
    const idleSec = Math.floor((now - lastOutput) / 1000);
  
    if (idleSec > 0 && idleSec * 1000 < noLogTimeoutMs) {
      // update every second
      updateDisplay(currentStep, 170, `⏳ No logs for ${idleSec}s...`);
    }
  
    if (idleSec * 1000 >= noLogTimeoutMs) {
      console.warn(`\n⚠️ No logs for ${idleSec}s → restarting...`);
      child.kill("SIGINT");
      restart();
      return;
    }
  
    timer = setTimeout(checkStuck, 1000);
  }
  

  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);

  child.on("exit", () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    console.log("\nProcess exited.");
    restart(); // restart if child exits unexpectedly
  });

  timer = setTimeout(checkStuck, 1000);

  heartbeat = setInterval(() => {
    if (sessionActive) {
      updateDisplay(currentStep, 170, latestLog || "");
    }
  }, 1000);
}

start();
