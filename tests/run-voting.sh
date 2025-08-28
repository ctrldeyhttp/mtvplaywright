#!/bin/bash
# =========================
# Wrapper for Playwright Voting Script
# =========================

SCRIPT_PATH="./voting.spec.ts"
LOG_DIR="./logs"

# Create log directory if it doesn't exist
mkdir -p "$LOG_DIR"

COUNTER=0

while true; do
  COUNTER=$((COUNTER + 1))
  TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
  LOG_FILE="$LOG_DIR/run_$COUNTER_$TIMESTAMP.log"

  echo "🚀 Starting Playwright script (run #$COUNTER)..."
  echo "Logging to $LOG_FILE"

  # Run the script and pipe stdout/stderr to the log file
  npx ts-node "$SCRIPT_PATH" &> "$LOG_FILE"

  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Script finished normally."
    break
  else
    echo "⚠️ Script exited with code $EXIT_CODE. Restarting in 2s..."
    sleep 2
  fi
done
