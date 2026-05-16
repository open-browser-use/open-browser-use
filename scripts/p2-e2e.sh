#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OBU_E2E_CDP_PORT:-9223}"
if [[ -n "${OBU_CDP_URL:-}" && -z "${OBU_E2E_CDP_PORT:-}" && "${OBU_CDP_URL}" =~ ^https?://[^:/]+:([0-9]+) ]]; then
  PORT="${BASH_REMATCH[1]}"
fi
CDP_URL="${OBU_CDP_URL:-http://127.0.0.1:${PORT}}"
CHROME_BIN="${OBU_CHROME_BIN:-}"
CHROME_PID=""
USER_DATA_DIR=""

cd "$ROOT"

cdp_ready() {
  curl -fsS "${CDP_URL}/json/version" >/dev/null 2>&1
}

find_chrome() {
  if [[ -n "$CHROME_BIN" ]]; then
    printf '%s\n' "$CHROME_BIN"
    return
  fi

  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    printf '%s\n' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return
  fi

  for candidate in google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done

  return 1
}

cleanup() {
  if [[ -n "$CHROME_PID" ]]; then
    kill "$CHROME_PID" >/dev/null 2>&1 || true
    wait "$CHROME_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$USER_DATA_DIR" ]]; then
    rm -rf "$USER_DATA_DIR"
  fi
}
trap cleanup EXIT

if ! cdp_ready; then
  CHROME="$(find_chrome)" || {
    echo "No Chrome/Chromium binary found. Set OBU_CHROME_BIN=/path/to/chrome." >&2
    exit 1
  }
  USER_DATA_DIR="$(mktemp -d /tmp/obu-chrome.XXXXXX)"
  "$CHROME" \
    --headless=new \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --remote-allow-origins='*' \
    about:blank >/tmp/obu-p2-e2e-chrome.log 2>&1 &
  CHROME_PID="$!"

  for _ in {1..100}; do
    if cdp_ready; then
      break
    fi
    sleep 0.1
  done

  if ! cdp_ready; then
    echo "Chrome did not expose CDP at ${CDP_URL}. See /tmp/obu-p2-e2e-chrome.log." >&2
    exit 1
  fi
fi

pnpm -C packages/sdk build
cargo build -p obu-host -p obu-node-repl

OBU_CDP_URL="$CDP_URL" cargo test -p obu-host --test cdp_playwright_locator_click -- --ignored
OBU_CDP_URL="$CDP_URL" cargo test -p obu-host --test e2e_failure_modes -- --ignored
