#!/bin/sh
set -eu

INSTALL_DIR="${OBU_INSTALL_DIR:-"$HOME/.obu"}"
ARTIFACT="${OBU_ARTIFACT:-}"
CHECKSUM="${OBU_ARTIFACT_SHA256:-}"
NO_MODIFY_PATH=0
UNMANAGED="${OBU_UNMANAGED_INSTALL:-0}"

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

update_profile_path() {
  bin_dir="$1"
  profile="${HOME:-}/.profile"
  [ -n "${HOME:-}" ] || return 0
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
    --unmanaged)
      UNMANAGED=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: install.sh --artifact <path-or-url> [--checksum <sha256>] [--install-dir <dir>] [--no-modify-path] [--unmanaged]

Environment:
  OBU_INSTALL_DIR        Install root, defaults to $HOME/.obu
  OBU_ARTIFACT          Artifact path or URL when --artifact is omitted
  OBU_ARTIFACT_SHA256   Expected artifact SHA-256
  OBU_UNMANAGED_INSTALL Disable shell profile PATH edits
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

[ -n "$ARTIFACT" ] || { echo "missing artifact; pass --artifact or set OBU_ARTIFACT" >&2; exit 2; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/obu-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

case "$ARTIFACT" in
  http://*|https://*)
    command -v curl >/dev/null 2>&1 || { echo "curl is required to download $ARTIFACT" >&2; exit 2; }
    ARTIFACT_FILE="$TMP_DIR/payload.tar.gz"
    curl -fsSL "$ARTIFACT" -o "$ARTIFACT_FILE"
    ;;
  *)
    ARTIFACT_FILE="$ARTIFACT"
    ;;
esac

if [ -n "$CHECKSUM" ]; then
  ACTUAL="$(sha256_file "$ARTIFACT_FILE")"
  if [ "$ACTUAL" != "$CHECKSUM" ]; then
    echo "checksum mismatch for $ARTIFACT_FILE" >&2
    echo "expected: $CHECKSUM" >&2
    echo "actual:   $ACTUAL" >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR/payloads" "$INSTALL_DIR/bin"
PAYLOAD_NAME="$(artifact_name "$ARTIFACT_FILE")"
PAYLOAD_DIR="$INSTALL_DIR/payloads/$PAYLOAD_NAME"
rm -rf "$PAYLOAD_DIR.tmp" "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR.tmp"
tar -xzf "$ARTIFACT_FILE" -C "$PAYLOAD_DIR.tmp"
mv "$PAYLOAD_DIR.tmp" "$PAYLOAD_DIR"
rm -f "$INSTALL_DIR/payloads/current"
ln -s "$PAYLOAD_NAME" "$INSTALL_DIR/payloads/current"

cat > "$INSTALL_DIR/bin/obu" <<'SHIM'
#!/bin/sh
set -eu
BIN_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PAYLOAD_ROOT="${OBU_PAYLOAD_ROOT:-"$BIN_DIR/../payloads/current"}"
NODE_BIN="${OBU_NODE_BINARY:-"$PAYLOAD_ROOT/node/bin/node"}"
export OBU_PAYLOAD_ROOT="$PAYLOAD_ROOT"
export OBU_NODE_BINARY="$NODE_BIN"
export OBU_COMMAND="$0"
exec "$NODE_BIN" "$PAYLOAD_ROOT/cli/dist/index.js" "$@"
SHIM
chmod 755 "$INSTALL_DIR/bin/obu"
ln -sf obu "$INSTALL_DIR/bin/open-browser-use"

if [ "$NO_MODIFY_PATH" -eq 0 ] && [ "$UNMANAGED" != "1" ]; then
  update_profile_path "$INSTALL_DIR/bin"
fi

echo "open-browser-use installed at $INSTALL_DIR"
echo "Run: $INSTALL_DIR/bin/obu setup"
