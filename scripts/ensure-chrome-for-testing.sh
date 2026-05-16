#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="${OBU_E2E_BROWSER_CACHE:-$HOME/.cache/open-browser-use-browsers}"
CFT_VERSIONS_URL="${OBU_CHROME_FOR_TESTING_VERSIONS_URL:-https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json}"
DOWNLOAD_TIMEOUT="${OBU_E2E_BROWSER_DOWNLOAD_TIMEOUT:-900}"
DOWNLOAD_ATTEMPTS="${OBU_E2E_BROWSER_DOWNLOAD_ATTEMPTS:-8}"

compatible_path() {
  local path="$1"
  [[ -x "$path" ]] || return 1
  if [[ "$path" == "$CACHE_DIR"/* && "$(basename "$path")" == "chrome" ]]; then
    return 0
  fi
  case "$path" in
    *"Google Chrome for Testing.app"*|*"Chromium.app"*|*"chromium"*|*"chrome-for-testing"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

print_if_compatible() {
  local candidate="$1"
  if compatible_path "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

find_existing() {
  if [[ -n "${OBU_WEBEXT_CHROME_BIN:-}" ]]; then
    print_if_compatible "$OBU_WEBEXT_CHROME_BIN" && return 0
  fi
  if [[ -n "${OBU_CHROME_BIN:-}" ]]; then
    print_if_compatible "$OBU_CHROME_BIN" && return 0
  fi

  print_if_compatible "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" && return 0
  print_if_compatible "/Applications/Chromium.app/Contents/MacOS/Chromium" && return 0

  for candidate in google-chrome-for-testing chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      print_if_compatible "$(command -v "$candidate")" && return 0
    fi
  done

  if [[ -d "$CACHE_DIR" ]]; then
    while IFS= read -r candidate; do
      print_if_compatible "$candidate" && return 0
    done < <(
      find "$CACHE_DIR" -type f \( \
        -path '*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
        -o -name chrome \
        -o -name chromium \
        -o -name chrome-for-testing \
      \) 2>/dev/null
    )
  fi

  return 1
}

if find_existing; then
  exit 0
fi

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required to install Chrome for Testing." >&2
    exit 1
  fi
}

chrome_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64|Darwin:aarch64)
      printf '%s\n' "mac-arm64"
      ;;
    Darwin:x86_64|Darwin:amd64)
      printf '%s\n' "mac-x64"
      ;;
    Linux:x86_64|Linux:amd64)
      printf '%s\n' "linux64"
      ;;
    *)
      echo "Chrome for Testing does not publish a chrome binary for $os/$arch; set OBU_WEBEXT_CHROME_BIN to a compatible Chromium binary." >&2
      exit 1
      ;;
  esac
}

resolve_download() {
  local platform="$1"
  local versions_file="$2"
  node - "$platform" "$versions_file" <<'NODE'
const fs = require("node:fs");

const [platform, versionsFile] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(versionsFile, "utf8"));
const stable = data.channels?.Stable;
const downloads = stable?.downloads?.chrome ?? [];
const match = downloads.find((entry) => entry.platform === platform);
if (!stable?.version || !match?.url) {
  console.error(`No Stable Chrome for Testing download found for ${platform}.`);
  process.exit(1);
}
process.stdout.write(`${stable.version}\n${match.url}\n`);
NODE
}

require_command curl
require_command node
require_command unzip

archive_ok() {
  local archive="$1"
  [[ -f "$archive" ]] && unzip -tq "$archive" >/dev/null 2>&1
}

file_size() {
  local path="$1"
  if [[ -f "$path" ]]; then
    wc -c < "$path" | tr -d ' '
  else
    printf '%s' 0
  fi
}

mkdir -p "$CACHE_DIR"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/obu-chrome-for-testing.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

platform="$(chrome_platform)"
versions_file="$tmp_dir/last-known-good-versions-with-downloads.json"
echo "Resolving Chrome for Testing Stable download for $platform" >&2
curl -fsSL \
  --retry 3 \
  --retry-delay 2 \
  --retry-connrefused \
  --connect-timeout 20 \
  --max-time 60 \
  -o "$versions_file" \
  "$CFT_VERSIONS_URL"

download_info="$(resolve_download "$platform" "$versions_file")"
version="$(printf '%s\n' "$download_info" | sed -n '1p')"
url="$(printf '%s\n' "$download_info" | sed -n '2p')"
install_root="$CACHE_DIR/chrome/$version-$platform"
zip_cache="$CACHE_DIR/chrome/$version-$platform.zip"
zip_part="$zip_cache.part"
extract_tmp="$tmp_dir/extract"

echo "Installing Chrome for Testing $version under $CACHE_DIR" >&2
mkdir -p "$(dirname "$zip_cache")" "$extract_tmp"
if [[ -f "$zip_cache" && ! -d "$install_root" ]]; then
  if archive_ok "$zip_cache"; then
    echo "Using cached Chrome for Testing archive $zip_cache" >&2
  else
    echo "Resuming incomplete Chrome for Testing archive $zip_cache" >&2
    if [[ ! -f "$zip_part" || "$(file_size "$zip_cache")" -gt "$(file_size "$zip_part")" ]]; then
      mv -f "$zip_cache" "$zip_part"
    else
      rm -f "$zip_cache"
    fi
  fi
fi
if [[ ! -f "$zip_cache" ]]; then
  attempt=1
  while ! archive_ok "$zip_part"; do
    echo "Downloading Chrome for Testing archive (attempt $attempt/$DOWNLOAD_ATTEMPTS, partial $(file_size "$zip_part") bytes)" >&2
    if curl -fL \
      -C - \
      --retry 0 \
      --connect-timeout 30 \
      --max-time "$DOWNLOAD_TIMEOUT" \
      -o "$zip_part" \
      "$url"; then
      if archive_ok "$zip_part"; then
        break
      fi
      echo "Downloaded Chrome for Testing archive failed integrity check; retrying with resume." >&2
    else
      echo "Chrome for Testing archive download failed; retrying with resume." >&2
    fi

    if [[ "$attempt" -ge "$DOWNLOAD_ATTEMPTS" ]]; then
      echo "Chrome for Testing archive did not complete after $DOWNLOAD_ATTEMPTS attempts. Re-run this script to resume $zip_part." >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  mv "$zip_part" "$zip_cache"
fi
rm -rf "$install_root.tmp" "$install_root"
unzip -q "$zip_cache" -d "$install_root.tmp"
mv "$install_root.tmp" "$install_root"

find_existing || {
  echo "Chrome for Testing install completed, but no compatible executable was found under $CACHE_DIR." >&2
  exit 1
}
