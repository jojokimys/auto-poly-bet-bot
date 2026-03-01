#!/bin/bash
# Periodically clear .next/cache every 15 minutes
# Launched as background process by `yarn dev`, killed on exit

INTERVAL=900  # 15 minutes
CACHE_DIR="$(dirname "$0")/../.next/cache"

while true; do
  sleep "$INTERVAL"
  if [ -d "$CACHE_DIR" ]; then
    SIZE=$(du -sh "$CACHE_DIR" 2>/dev/null | cut -f1)
    rm -rf "$CACHE_DIR"
    echo "[cache-cleaner] Cleared .next/cache ($SIZE) at $(date '+%H:%M:%S')"
  fi
done
