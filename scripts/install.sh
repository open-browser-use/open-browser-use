#!/bin/sh
set -eu

INSTALL_DIR="${OBU_INSTALL_DIR:-"$HOME/.obu"}"
ARTIFACT="${OBU_ARTIFACT:-}"
CHECKSUM="${OBU_ARTIFACT_SHA256:-}"
RELEASE_BASE_URL="${OBU_RELEASE_BASE_URL:-"https://github.com/open-browser-use/open-browser-use/releases/latest/download"}"
TARGET="${OBU_TARGET:-}"
SELECTED_TARGET="$TARGET"
NO_MODIFY_PATH=0
UNMANAGED="${OBU_UNMANAGED_INSTALL:-0}"
VERBOSE=0

log_verbose() {
  if [ "$VERBOSE" -eq 1 ]; then
    printf '%s\n' "$*"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required for checksum verification" >&2
    exit 2
  fi
}

artifact_name() {
  base="$(basename "$1")"
  base="${base%.tar.gz}"
  base="${base%.tgz}"
  printf '%s\n' "$base"
}

download_to() {
  src="$1"
  dest="$2"
  if ! try_download_to "$src" "$dest"; then
    echo "download failed: $src" >&2
    echo "Check network access or pass --artifact <path> with a local release artifact." >&2
    exit 2
  fi
}

try_download_to() {
  src="$1"
  dest="$2"
  case "$src" in
    http://*|https://*)
      command -v curl >/dev/null 2>&1 || return 127
      curl -fsSL "$src" -o "$dest"
      ;;
    file://*)
      cp "${src#file://}" "$dest"
      ;;
    *)
      cp "$src" "$dest"
      ;;
  esac
}

join_release_path() {
  base="${1%/}"
  file="$2"
  printf '%s/%s\n' "$base" "$file"
}

detect_target() {
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  case "$os:$arch" in
    Darwin:arm64|Darwin:aarch64)
      printf '%s\n' "darwin-arm64"
      ;;
    Darwin:x86_64|Darwin:amd64)
      printf '%s\n' "darwin-x64"
      ;;
    Linux:x86_64|Linux:amd64)
      if ldd --version 2>&1 | grep -qi musl; then
        printf '%s\n' "linux-x64-musl"
      else
        printf '%s\n' "linux-x64-gnu"
      fi
      ;;
    Linux:aarch64|Linux:arm64)
      if ldd --version 2>&1 | grep -qi musl; then
        printf '%s\n' "linux-arm64-musl"
      else
        printf '%s\n' "linux-arm64-gnu"
      fi
      ;;
    *)
      echo "unsupported platform for open-browser-use release artifact: $os/$arch" >&2
      exit 2
      ;;
  esac
}

manifest_artifact_field() {
  manifest="$1"
  target="$2"
  field="$3"
  awk -v target="$target" -v field="$field" '
    BEGIN { in_object = 0; object = "" }
    /{/ { in_object = 1; object = "" }
    in_object { object = object $0 "\n" }
    /}/ && in_object {
      flat = object
      gsub(/\n/, " ", flat)
      if (flat ~ "\"target\"[[:space:]]*:[[:space:]]*\"" target "\"") {
        pattern = "\"" field "\"[[:space:]]*:[[:space:]]*\""
        if (match(flat, pattern)) {
          rest = substr(flat, RSTART + RLENGTH)
          split(rest, parts, "\"")
          print parts[1]
          exit
        }
      }
      in_object = 0
    }
  ' "$manifest"
}

manifest_tsv_field() {
  manifest="$1"
  target="$2"
  field="$3"
  awk -F '	' -v target="$target" -v field="$field" '
    NR == 1 {
      for (i = 1; i <= NF; i += 1) {
        if ($i == field) field_index = i
      }
      next
    }
    $1 == target && field_index > 0 {
      print $field_index
      exit
    }
  ' "$manifest"
}

resolve_release_artifact() {
  target="$TARGET"
  if [ -z "$target" ]; then
    target="$(detect_target)"
  fi
  SELECTED_TARGET="$target"
  log_verbose "target: $target"

  manifest_name="manifest.tsv"
  manifest_file="$TMP_DIR/$manifest_name"
  if try_download_to "$(join_release_path "$RELEASE_BASE_URL" "$manifest_name")" "$manifest_file" >/dev/null 2>&1; then
    log_verbose "manifest: $(join_release_path "$RELEASE_BASE_URL" "$manifest_name")"
    artifact_file="$(manifest_tsv_field "$manifest_file" "$target" "file")"
    artifact_sha="$(manifest_tsv_field "$manifest_file" "$target" "sha256")"
  else
    manifest_name="manifest.json"
    manifest_file="$TMP_DIR/$manifest_name"
    download_to "$(join_release_path "$RELEASE_BASE_URL" "$manifest_name")" "$manifest_file"
    log_verbose "manifest: $(join_release_path "$RELEASE_BASE_URL" "$manifest_name")"
    artifact_file="$(manifest_artifact_field "$manifest_file" "$target" "file")"
    artifact_sha="$(manifest_artifact_field "$manifest_file" "$target" "sha256")"
  fi
  if [ -z "$artifact_file" ] || [ -z "$artifact_sha" ]; then
    echo "no open-browser-use release artifact for target $target in $RELEASE_BASE_URL/$manifest_name" >&2
    exit 2
  fi
  case "$artifact_file" in
    */*|*\\*|"")
      echo "invalid open-browser-use release artifact file for target $target: $artifact_file" >&2
      exit 2
      ;;
  esac
  case "$artifact_sha" in
    *[!0-9a-f]*|"")
      echo "invalid open-browser-use release artifact checksum for target $target" >&2
      exit 2
      ;;
  esac
  if [ "${#artifact_sha}" -ne 64 ]; then
    echo "invalid open-browser-use release artifact checksum for target $target" >&2
    exit 2
  fi
  ARTIFACT="$(join_release_path "$RELEASE_BASE_URL" "$artifact_file")"
  log_verbose "artifact: $ARTIFACT"
  if [ -z "$CHECKSUM" ]; then
    CHECKSUM="$artifact_sha"
  fi
}

update_profile_path() {
  bin_dir="$1"
  [ -n "${HOME:-}" ] || return 0
  append_profile_path "${HOME:-}/.profile" "$bin_dir"
  shell_name=""
  if [ -n "${SHELL:-}" ]; then
    shell_name="$(basename "$SHELL")"
  fi
  case "$shell_name" in
    zsh)
      append_profile_path "${HOME:-}/.zshrc" "$bin_dir"
      ;;
    bash)
      append_profile_path "${HOME:-}/.bashrc" "$bin_dir"
      ;;
  esac
}

append_profile_path() {
  profile="$1"
  bin_dir="$2"
  mkdir -p "$(dirname "$profile")"
  marker="# open-browser-use installer PATH"
  if [ -f "$profile" ] && grep -F "$marker" "$profile" >/dev/null 2>&1; then
    return 0
  fi
  {
    echo ""
    echo "$marker"
    echo "export PATH=\"$bin_dir:\$PATH\""
  } >> "$profile"
}

install_path_shims() {
  bin_dir="$1"
  [ -n "${PATH:-}" ] || return 1
  old_ifs="$IFS"
  IFS=:
  set -- $PATH
  IFS="$old_ifs"
  for dir do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    [ -w "$dir" ] || continue
    obu_link="$dir/obu"
    if [ "$obu_link" = "$bin_dir/obu" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    if [ -e "$obu_link" ] || [ -L "$obu_link" ]; then
      if [ "$(readlink "$obu_link" 2>/dev/null || true)" = "$bin_dir/obu" ]; then
        printf '%s\n' "$dir"
        return 0
      fi
      continue
    fi
    if ln -s "$bin_dir/obu" "$obu_link" 2>/dev/null; then
      open_link="$dir/open-browser-use"
      if [ ! -e "$open_link" ] && [ ! -L "$open_link" ]; then
        ln -s "$bin_dir/open-browser-use" "$open_link" 2>/dev/null || true
      fi
      printf '%s\n' "$dir"
      return 0
    fi
  done
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact)
      shift
      [ "$#" -gt 0 ] || { echo "--artifact requires a path or URL" >&2; exit 2; }
      ARTIFACT="$1"
      ;;
    --checksum)
      shift
      [ "$#" -gt 0 ] || { echo "--checksum requires a sha256 value" >&2; exit 2; }
      CHECKSUM="$1"
      ;;
    --install-dir)
      shift
      [ "$#" -gt 0 ] || { echo "--install-dir requires a directory" >&2; exit 2; }
      INSTALL_DIR="$1"
      ;;
    --no-modify-path)
      NO_MODIFY_PATH=1
      ;;
    --verbose)
      VERBOSE=1
      ;;
    --unmanaged)
      UNMANAGED=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: install.sh [--artifact <path-or-url>] [--checksum <sha256>] [--install-dir <dir>] [--no-modify-path] [--verbose] [--unmanaged]

Environment:
  OBU_INSTALL_DIR        Install root, defaults to $HOME/.obu
  OBU_ARTIFACT          Artifact path or URL when --artifact is omitted
  OBU_ARTIFACT_SHA256   Expected artifact SHA-256
  OBU_RELEASE_BASE_URL   Release asset base URL with manifest.tsv or manifest.json
  OBU_TARGET             Override target triple from release manifest
  OBU_UNMANAGED_INSTALL Disable PATH integration
USAGE
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/obu-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if [ -z "$ARTIFACT" ]; then
  resolve_release_artifact
fi

case "$ARTIFACT" in
  http://*|https://*)
    ARTIFACT_FILE="$TMP_DIR/$(basename "$ARTIFACT")"
    log_verbose "download: $ARTIFACT -> $ARTIFACT_FILE"
    download_to "$ARTIFACT" "$ARTIFACT_FILE"
    ;;
  file://*)
    ARTIFACT_FILE="$TMP_DIR/$(basename "$ARTIFACT")"
    log_verbose "copy: $ARTIFACT -> $ARTIFACT_FILE"
    download_to "$ARTIFACT" "$ARTIFACT_FILE"
    ;;
  *)
    ARTIFACT_FILE="$ARTIFACT"
    log_verbose "artifact file: $ARTIFACT_FILE"
    ;;
esac

if [ -n "$CHECKSUM" ]; then
  log_verbose "checksum: verifying $ARTIFACT_FILE"
  ACTUAL="$(sha256_file "$ARTIFACT_FILE")"
  if [ "$ACTUAL" != "$CHECKSUM" ]; then
    echo "checksum verification failed for $ARTIFACT_FILE" >&2
    echo "expected: $CHECKSUM" >&2
    echo "actual:   $ACTUAL" >&2
    echo "Download the artifact again or pass the checksum that matches the artifact." >&2
    exit 1
  fi
  log_verbose "checksum: ok"
fi

mkdir -p "$INSTALL_DIR/payloads" "$INSTALL_DIR/bin"
PAYLOAD_NAME="$(artifact_name "$ARTIFACT_FILE")"
PAYLOAD_DIR="$INSTALL_DIR/payloads/$PAYLOAD_NAME"
rm -rf "$PAYLOAD_DIR.tmp" "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR.tmp"
log_verbose "extract: $ARTIFACT_FILE -> $PAYLOAD_DIR"
if ! tar -xzf "$ARTIFACT_FILE" -C "$PAYLOAD_DIR.tmp"; then
  echo "extract failed: could not unpack $ARTIFACT_FILE" >&2
  echo "Check that the artifact is a valid open-browser-use .tar.gz file." >&2
  exit 1
fi
mv "$PAYLOAD_DIR.tmp" "$PAYLOAD_DIR"
rm -f "$INSTALL_DIR/payloads/current"
ln -s "$PAYLOAD_NAME" "$INSTALL_DIR/payloads/current"

cat > "$INSTALL_DIR/bin/obu" <<'SHIM'
#!/bin/sh
set -eu
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE_TARGET="$(readlink "$SOURCE")"
  case "$SOURCE_TARGET" in
    /*)
      SOURCE="$SOURCE_TARGET"
      ;;
    *)
      SOURCE="$SOURCE_DIR/$SOURCE_TARGET"
      ;;
  esac
done
BIN_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
PAYLOAD_ROOT="${OBU_PAYLOAD_ROOT:-"$BIN_DIR/../payloads/current"}"
NODE_BIN="${OBU_NODE_BINARY:-"$PAYLOAD_ROOT/node/bin/node"}"
export OBU_PAYLOAD_ROOT="$PAYLOAD_ROOT"
export OBU_NODE_BINARY="$NODE_BIN"
export OBU_COMMAND="$0"
exec "$NODE_BIN" "$PAYLOAD_ROOT/cli/dist/index.js" "$@"
SHIM
chmod 755 "$INSTALL_DIR/bin/obu"
ln -sf obu "$INSTALL_DIR/bin/open-browser-use"
log_verbose "shim: wrote $INSTALL_DIR/bin/obu"

if [ "$NO_MODIFY_PATH" -eq 0 ] && [ "$UNMANAGED" != "1" ]; then
  PATH_SHIM_DIR="$(install_path_shims "$INSTALL_DIR/bin" || true)"
  if [ -n "$PATH_SHIM_DIR" ]; then
    log_verbose "path: linked obu in $PATH_SHIM_DIR"
  else
    log_verbose "path: no writable current PATH directory for an immediate obu shim"
  fi
  update_profile_path "$INSTALL_DIR/bin"
  log_verbose "path: ensured $INSTALL_DIR/bin in shell profile"
else
  log_verbose "path: skipped PATH integration"
fi

if [ -n "$SELECTED_TARGET" ]; then
  echo "Selected target: $SELECTED_TARGET"
fi
echo "open-browser-use installed at $INSTALL_DIR"
echo "Run: $INSTALL_DIR/bin/obu setup"
