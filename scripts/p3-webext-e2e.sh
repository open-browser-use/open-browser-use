#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME_BIN="${OBU_WEBEXT_CHROME_BIN:-${OBU_CHROME_BIN:-}}"
BROWSER_TARGET="${OBU_WEBEXT_E2E_BROWSER:-}"
TMP_DIR=""
CHROME_PID=""

cleanup() {
  local status=$?
  if [[ -n "$CHROME_PID" ]]; then
    kill "$CHROME_PID" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      if ! kill -0 "$CHROME_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    kill -9 "$CHROME_PID" >/dev/null 2>&1 || true
    wait "$CHROME_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TMP_DIR" ]]; then
    if [[ "$status" -eq 0 && "${OBU_KEEP_E2E_TMP:-}" != "1" ]]; then
      rm -rf "$TMP_DIR"
    else
      echo "Preserved P3 WebExtension E2E temp dir: $TMP_DIR" >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

find_chrome() {
  if [[ -n "$CHROME_BIN" ]]; then
    printf '%s\n' "$CHROME_BIN"
    return
  fi

  if [[ -x "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" ]]; then
    printf '%s\n' "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    return
  fi

  if [[ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]]; then
    printf '%s\n' "/Applications/Chromium.app/Contents/MacOS/Chromium"
    return
  fi

  for candidate in google-chrome-for-testing chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done

  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    printf '%s\n' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return
  fi

  for candidate in google-chrome chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done

  return 1
}

wait_for_descriptor() {
  local descriptor_dir="$1/webextension"
  for _ in {1..300}; do
    if find "$descriptor_dir" -name '*.json' -print -quit >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cd "$ROOT"

CHROME="$(find_chrome)" || {
  if [[ "${OBU_WEBEXT_E2E_AUTO_INSTALL:-}" == "1" ]]; then
    CHROME="$("$ROOT/scripts/ensure-chrome-for-testing.sh")"
  else
    cat >&2 <<'EOF'
No Chrome for Testing or Chromium binary found.
Set OBU_WEBEXT_CHROME_BIN=/path/to/chrome-for-testing-or-chromium, run
scripts/ensure-chrome-for-testing.sh, or set OBU_WEBEXT_E2E_AUTO_INSTALL=1.
EOF
    exit 1
  fi
}
if [[ "$CHROME" == *"Google Chrome.app"* && "${OBU_WEBEXT_E2E_ALLOW_BRANDED:-}" != "1" ]]; then
  if [[ "${OBU_WEBEXT_E2E_AUTO_INSTALL:-}" == "1" ]]; then
    CHROME="$("$ROOT/scripts/ensure-chrome-for-testing.sh")"
  else
    cat >&2 <<'EOF'
P3 WebExtension E2E requires Chrome for Testing or Chromium.
Official branded Google Chrome no longer supports the --load-extension automation path reliably.
Set OBU_WEBEXT_CHROME_BIN=/path/to/chrome-for-testing-or-chromium, run
scripts/ensure-chrome-for-testing.sh, set OBU_WEBEXT_E2E_AUTO_INSTALL=1, or set
OBU_WEBEXT_E2E_ALLOW_BRANDED=1 to try branded Chrome manually.
EOF
    exit 1
  fi
fi
if [[ -z "$BROWSER_TARGET" ]]; then
  if [[ "$CHROME" == *"Chrome for Testing"* ]]; then
    BROWSER_TARGET="chrome-for-testing"
  elif [[ "$CHROME" == *"Chromium"* || "$(basename "$CHROME")" == chromium* ]]; then
    BROWSER_TARGET="chromium"
  else
    BROWSER_TARGET="chrome"
  fi
fi

pnpm -C packages/sdk build
pnpm -C packages/extension build
cargo build -p obu-host -p obu-node-repl

TMP_DIR="$(mktemp -d /tmp/obu-p3-webext.XXXXXX)"
HOME_DIR="$TMP_DIR/home"
XDG_DIR="$HOME_DIR/.config"
PROFILE_DIR="$TMP_DIR/profile"
PROFILE_NATIVE_HOSTS="$PROFILE_DIR/NativeMessagingHosts"
WRAPPER_DIR="$TMP_DIR/native-host-wrapper"
RUNTIME_DIR="$TMP_DIR/runtime"
DOWNLOAD_DIR="$TMP_DIR/downloads"
mkdir -p "$HOME_DIR" "$XDG_DIR" "$PROFILE_DIR/Default" "$RUNTIME_DIR" "$DOWNLOAD_DIR"
chmod 700 "$RUNTIME_DIR"

cat >"$PROFILE_DIR/Default/Preferences" <<EOF
{
  "download": {
    "default_directory": "$DOWNLOAD_DIR",
    "directory_upgrade": true,
    "prompt_for_download": false
  },
  "profile": {
    "default_content_setting_values": {
      "automatic_downloads": 1
    }
  },
  "safebrowsing": {
    "enabled": false
  }
}
EOF

if [[ "$(uname -s)" == "Darwin" ]]; then
  pnpm -C packages/extension dev:manifest -- \
    --browser "$BROWSER_TARGET" \
    --output-dir "$PROFILE_NATIVE_HOSTS" \
    --host-binary "$ROOT/target/debug/obu-host" \
    --wrapper-dir "$WRAPPER_DIR"
else
  HOME="$HOME_DIR" XDG_CONFIG_HOME="$XDG_DIR" \
    pnpm -C packages/extension dev:manifest -- \
    --browser "$BROWSER_TARGET" \
    --output-dir "$PROFILE_NATIVE_HOSTS" \
    --host-binary "$ROOT/target/debug/obu-host" \
    --wrapper-dir "$WRAPPER_DIR"
fi

CHROME_ARGS=(
  "--user-data-dir=$PROFILE_DIR"
  "--load-extension=$ROOT/packages/extension/dist"
  "--disable-extensions-except=$ROOT/packages/extension/dist"
  "--no-first-run"
  "--no-default-browser-check"
  "about:blank"
)
if [[ "$(uname -s)" == "Darwin" ]]; then
  CHROME_ARGS=("--use-mock-keychain" "${CHROME_ARGS[@]}")
fi
if [[ "${OBU_WEBEXT_E2E_HEADLESS:-}" == "1" ]]; then
  CHROME_ARGS=("--headless=new" "${CHROME_ARGS[@]}")
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  OBU_RUNTIME_DIR="$RUNTIME_DIR" "$CHROME" "${CHROME_ARGS[@]}" >"$TMP_DIR/chrome.log" 2>&1 &
else
  HOME="$HOME_DIR" XDG_CONFIG_HOME="$XDG_DIR" OBU_RUNTIME_DIR="$RUNTIME_DIR" \
    "$CHROME" "${CHROME_ARGS[@]}" >"$TMP_DIR/chrome.log" 2>&1 &
fi
CHROME_PID="$!"

if ! wait_for_descriptor "$RUNTIME_DIR"; then
  echo "WebExtension backend descriptor was not written. Chrome log: $TMP_DIR/chrome.log" >&2
  exit 1
fi

OBU_RUNTIME_DIR="$RUNTIME_DIR" \
  cargo test -p obu-host --test e2e_node_repl_to_webextension -- --ignored --nocapture
