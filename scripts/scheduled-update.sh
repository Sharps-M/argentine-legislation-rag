#!/usr/bin/env bash
# The daily check, for a scheduler: Windows Task Scheduler through wsl.exe, or
# cron. Every day it says how long ago the corpus was last brought up to date;
# once a week has passed, it runs the update. Everything goes to the end of
# data/updates/update.log.
#
# Ollama has to be running for the update: it is checked before anything
# changes, and if it is not there the run is recorded as failed, the page says
# so, and the next day it is tried again.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data/updates

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S')"
  docker compose up -d db
  npm run update -- --if-due
  echo
} >> data/updates/update.log 2>&1
