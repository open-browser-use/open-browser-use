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
PAYLOAD_RETENTION="${OBU_PAYLOAD_RETENTION:-5}"
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

validate_payload_dir() {
  dir="$1"
  if [ ! -x "$dir/node/bin/node" ]; then
    echo "payload validation failed: node/bin/node is missing or not executable" >&2
    return 1
  fi
  if [ ! -x "$dir/bin/obu-host" ]; then
    echo "payload validation failed: bin/obu-host is missing or not executable" >&2
    return 1
  fi
  if [ ! -x "$dir/bin/obu-node-repl" ]; then
    echo "payload validation failed: bin/obu-node-repl is missing or not executable" >&2
    return 1
  fi
  if [ ! -f "$dir/cli/dist/index.js" ]; then
    echo "payload validation failed: cli/dist/index.js is missing" >&2
    return 1
  fi
  if [ ! -f "$dir/node_modules/@open-browser-use/sdk/dist/index.mjs" ]; then
    echo "payload validation failed: node_modules/@open-browser-use/sdk/dist/index.mjs is missing" >&2
    return 1
  fi
  if [ ! -f "$dir/extension/dist/manifest.json" ]; then
    echo "payload validation failed: extension/dist/manifest.json is missing" >&2
    return 1
  fi
  if [ ! -f "$dir/metadata.json" ]; then
    echo "payload validation failed: metadata.json is missing" >&2
    return 1
  fi
  if ! "$dir/node/bin/node" - "$dir" <<'JS'
const fs = require("fs");
const path = require("path");

const payloadDir = process.argv[2];
const metadata = JSON.parse(fs.readFileSync(path.join(payloadDir, "metadata.json"), "utf8"));
const requiredFiles = metadata?.release?.requiredFiles;
if (requiredFiles !== undefined) {
  if (!Array.isArray(requiredFiles)) {
    console.error("payload validation failed: release.requiredFiles must be an array");
    process.exit(1);
  }
  for (const entry of requiredFiles) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0 || path.isAbsolute(entry.path) || entry.path.split(/[\\/]+/).includes("..")) {
      console.error("payload validation failed: release.requiredFiles contains an invalid path");
      process.exit(1);
    }
    const file = path.join(payloadDir, entry.path);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      console.error(`payload validation failed: ${entry.path} is missing`);
      process.exit(1);
    }
    if (!stat.isFile()) {
      console.error(`payload validation failed: ${entry.path} is not a file`);
      process.exit(1);
    }
    if (entry.executable === true) {
      try {
        fs.accessSync(file, fs.constants.X_OK);
      } catch {
        console.error(`payload validation failed: ${entry.path} is not executable`);
        process.exit(1);
      }
    }
  }
}
JS
  then
    return 1
  fi
  return 0
}

validate_payload_retention() {
  value="$1"
  case "$value" in
    ''|*[!0123456789]*)
      echo "install failed: OBU_PAYLOAD_RETENTION must be a non-negative integer" >&2
      return 2
      ;;
  esac
  return 0
}

artifact_source_is_remote() {
  if [ -n "$ARTIFACT" ]; then
    case "$ARTIFACT" in http://*|https://*) return 0 ;; *) return 1 ;; esac
  fi
  case "$RELEASE_BASE_URL" in http://*|https://*) return 0 ;; *) return 1 ;; esac
}

warn_low_disk() {
  dir="$1"
  avail_kb="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
  case "$avail_kb" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$avail_kb" -lt 614400 ]; then
    echo "warning: only $((avail_kb / 1024)) MB free at $dir; install needs ~600 MB" >&2
  fi
}

preflight() {
  command -v tar >/dev/null 2>&1 || { echo "install failed: tar is required" >&2; exit 2; }
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    echo "install failed: sha256sum or shasum is required" >&2
    exit 2
  fi
  if artifact_source_is_remote; then
    command -v curl >/dev/null 2>&1 || {
      echo "install failed: curl is required to download a release artifact (or pass --artifact <local file>)" >&2
      exit 2
    }
  fi
  ancestor="$INSTALL_DIR"
  while [ ! -e "$ancestor" ] && [ "$ancestor" != "/" ] && [ "$ancestor" != "." ]; do
    ancestor="$(dirname "$ancestor")"
  done
  if [ ! -w "$ancestor" ]; then
    echo "install failed: $ancestor is not writable" >&2
    exit 1
  fi
  warn_low_disk "$ancestor"
}

prune_old_payloads() {
  payloads_dir="$1"
  active_payload="$2"
  rollback_payload="$3"
  keep_count="$4"

  validate_payload_retention "$keep_count" || return $?

  normalized_keep="$(printf '%s\n' "$keep_count" | sed 's/^0*//')"
  if [ -z "$normalized_keep" ]; then
    return 0
  fi
  if [ ! -d "$payloads_dir" ]; then
    return 0
  fi

  active_name="${active_payload##*/}"
  rollback_name="${rollback_payload##*/}"
  payload_names="$(ls -1t "$payloads_dir" 2>/dev/null || true)"
  kept_count=0
  old_ifs="$IFS"
  IFS='
'
  for payload_name in $payload_names; do
    case "$payload_name" in
      ''|.*|current)
        continue
        ;;
    esac

    payload_path="$payloads_dir/$payload_name"
    if [ ! -d "$payload_path" ] || [ -L "$payload_path" ]; then
      continue
    fi

    protected=0
    if [ "$payload_name" = "$active_name" ]; then
      protected=1
    elif [ -n "$rollback_name" ] && [ "$payload_name" = "$rollback_name" ]; then
      protected=1
    fi

    kept_count=$((kept_count + 1))
    if [ "$kept_count" -le "$normalized_keep" ] || [ "$protected" -eq 1 ]; then
      log_verbose "prune: keeping payload $payload_name"
      continue
    fi

    log_verbose "prune: removing old payload $payload_name"
    if ! rm -rf "$payload_path"; then
      echo "warning: could not remove old payload $payload_path" >&2
    fi
  done
  IFS="$old_ifs"
}

replace_symlink_path() {
  source="$1"
  dest="$2"
  if mv -fh "$source" "$dest" 2>/dev/null; then
    return 0
  fi
  if mv -fT "$source" "$dest" 2>/dev/null; then
    return 0
  fi
  rm -f "$dest" && mv -f "$source" "$dest"
}

run_payload_migrations() {
  payload_dir="$1"
  migration_dir="$payload_dir/install-migrations.d"
  [ -d "$migration_dir" ] || return 0

  for migration in "$migration_dir"/*; do
    [ -f "$migration" ] || continue
    migration_name="$(basename "$migration")"
    case "$migration_name" in
      [0-9][0-9][0-9]-*.sh)
        migration_slug="${migration_name#???-}"
        migration_slug="${migration_slug%.sh}"
        case "$migration_slug" in
          ""|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*)
            echo "payload migration has invalid name: $migration_name" >&2
            return 1
            ;;
        esac
        ;;
      *)
        echo "payload migration has invalid name: $migration_name" >&2
        return 1
        ;;
    esac
    if [ ! -x "$migration" ]; then
      echo "payload migration is not executable: $migration_name" >&2
      return 1
    fi
    log_verbose "migration: $migration_name"
    OBU_INSTALL_DIR="$INSTALL_DIR" \
      OBU_PAYLOAD_DIR="$payload_dir" \
      OBU_PREVIOUS_PAYLOAD="${PREVIOUS_CURRENT:-}" \
      "$migration"
  done
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

detect_shell_name() {
  if [ -n "${SHELL:-}" ]; then
    basename "$SHELL"
  else
    printf '%s\n' "sh"
  fi
}

write_env_file() {
  env_path="$INSTALL_DIR/env"
  if [ -L "$env_path" ]; then
    echo "warning: $env_path is a symlink; not writing env file" >&2
    return 1
  fi
  if [ -e "$env_path" ] && [ ! -f "$env_path" ]; then
    echo "warning: $env_path is not a regular file; not writing env file" >&2
    return 1
  fi
  env_stage="$(mktemp "$INSTALL_DIR/.env.tmp.XXXXXX")" || return 1
  cat > "$env_stage" <<EOF
#!/bin/sh
# open-browser-use environment — managed by the installer. Do not edit.
export OBU_INSTALL_DIR="$INSTALL_DIR"
case ":\${PATH}:" in
    *:"\${OBU_INSTALL_DIR}/bin":*) ;;
    *) export PATH="\${OBU_INSTALL_DIR}/bin:\$PATH" ;;
esac
EOF
  chmod 644 "$env_stage" 2>/dev/null || true
  if ! mv -f "$env_stage" "$env_path"; then
    rm -f "$env_stage"
    return 1
  fi
  return 0
}

# Print the profile files that should source the env file, one per line.
# zsh files are always safe to create; .bash_profile is only touched if it
# already exists (creating it would stop login bash from reading ~/.profile).
path_profile_targets() {
  [ -n "${HOME:-}" ] || return 0
  zdotdir="${ZDOTDIR:-$HOME}"
  printf '%s\n' "$HOME/.profile"
  printf '%s\n' "$HOME/.bashrc"
  printf '%s\n' "$zdotdir/.zshrc"
  printf '%s\n' "$zdotdir/.zprofile"
  if [ -f "$HOME/.bash_profile" ]; then
    printf '%s\n' "$HOME/.bash_profile"
  fi
}

append_source_block() {
  profile="$1"
  begin="# >>> open-browser-use installer (managed v1) >>>"
  end="# <<< open-browser-use installer (managed v1) <<<"
  line=". \"$INSTALL_DIR/env\""
  if [ -L "$profile" ]; then
    echo "warning: $profile is a symlink; not modifying PATH there" >&2
    return 1
  fi
  mkdir -p "$(dirname "$profile")" 2>/dev/null || true
  if [ -f "$profile" ] && grep -F "$begin" "$profile" >/dev/null 2>&1; then
    return 0
  fi
  {
    printf '\n%s\n' "$begin"
    printf '%s\n' "$line"
    printf '%s\n' "$end"
  } >> "$profile" || { echo "warning: could not update $profile" >&2; return 1; }
  return 0
}

configure_fish_path() {
  fish_root="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
  shell_name="$(detect_shell_name)"
  if [ ! -d "$fish_root" ] && [ "$shell_name" != "fish" ]; then
    return 0
  fi
  fish_file="$fish_root/conf.d/obu.fish"
  if [ -L "$fish_file" ]; then
    echo "warning: $fish_file is a symlink; skipping" >&2
    return 1
  fi
  mkdir -p "$fish_root/conf.d" 2>/dev/null || return 1
  fish_stage="$(mktemp "$fish_root/conf.d/.obu.fish.tmp.XXXXXX")" || return 1
  cat > "$fish_stage" <<EOF
# open-browser-use environment — managed by the installer. Do not edit.
set --global --export OBU_INSTALL_DIR "$INSTALL_DIR"
if type -q fish_add_path
    fish_add_path --global --path "$INSTALL_DIR/bin"
else if not contains "$INSTALL_DIR/bin" \$PATH
    set --global --export PATH "$INSTALL_DIR/bin" \$PATH
end
EOF
  mv -f "$fish_stage" "$fish_file" || { rm -f "$fish_stage"; return 1; }
  return 0
}

configure_path() {
  write_env_file || { echo "warning: could not write $INSTALL_DIR/env; PATH not configured" >&2; return 0; }
  path_profile_targets | while IFS= read -r profile; do
    append_source_block "$profile" || true
  done
  configure_fish_path || true
  return 0
}

should_modify_path() {
  [ "$NO_MODIFY_PATH" -eq 0 ] || return 1
  [ "$UNMANAGED" != "1" ] || return 1
  [ "${OBU_NO_MODIFY_PATH:-0}" != "1" ] || return 1
  return 0
}

warn_legacy_shellenv_line() {
  zdotdir="${ZDOTDIR:-$HOME}"
  for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$zdotdir/.zshrc" "$zdotdir/.zprofile"; do
    [ -f "$profile" ] || continue
    if grep -F "obu shellenv" "$profile" >/dev/null 2>&1; then
      echo "Note: $profile contains an older 'obu shellenv' line; it is superseded by '. \"$INSTALL_DIR/env\"' and can be removed." >&2
    fi
  done
}

print_path_activation() {
  shell_name="$(detect_shell_name)"
  echo
  echo "Added open-browser-use to your shell profile(s)."
  if [ "$shell_name" = "fish" ]; then
    echo "  Activate in this shell:  source \"${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/obu.fish\""
  else
    echo "  Activate in this shell:  . \"$INSTALL_DIR/env\""
  fi
  warn_legacy_shellenv_line
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
  OBU_UNMANAGED_INSTALL Skip shellenv PATH integration instructions
  OBU_PAYLOAD_RETENTION  Number of recent payloads to keep after activation; 0 disables pruning
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

validate_payload_retention "$PAYLOAD_RETENTION" || exit $?

preflight

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/obu-install.XXXXXX")"
PAYLOAD_STAGE_DIR=""
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$PAYLOAD_STAGE_DIR" ]; then
    rm -rf "$PAYLOAD_STAGE_DIR"
  fi
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
OBU_SHIM_PATH="$INSTALL_DIR/bin/obu"
if [ -L "$OBU_SHIM_PATH" ]; then
  echo "install failed: shim path is a symlink: $OBU_SHIM_PATH" >&2
  exit 1
fi
if [ -e "$OBU_SHIM_PATH" ] && [ ! -f "$OBU_SHIM_PATH" ]; then
  echo "install failed: shim path is not a regular file: $OBU_SHIM_PATH" >&2
  exit 1
fi
PAYLOAD_NAME="$(artifact_name "$ARTIFACT_FILE")"
PAYLOAD_DIR="$INSTALL_DIR/payloads/$PAYLOAD_NAME"
PAYLOAD_STAGE_DIR="$(mktemp -d "$INSTALL_DIR/payloads/.${PAYLOAD_NAME}.tmp.XXXXXX")"
PAYLOAD_BACKUP_DIR="$INSTALL_DIR/payloads/.${PAYLOAD_NAME}.previous.$$"
PREVIOUS_CURRENT="$(readlink "$INSTALL_DIR/payloads/current" 2>/dev/null || true)"
rm -rf "$PAYLOAD_BACKUP_DIR"
log_verbose "extract: $ARTIFACT_FILE -> $PAYLOAD_DIR"
if ! tar -xzf "$ARTIFACT_FILE" -C "$PAYLOAD_STAGE_DIR"; then
  echo "extract failed: could not unpack $ARTIFACT_FILE" >&2
  echo "Check that the artifact is a valid open-browser-use .tar.gz file." >&2
  exit 1
fi
if ! validate_payload_dir "$PAYLOAD_STAGE_DIR"; then
  echo "install failed: staged payload is not a valid open-browser-use release." >&2
  exit 1
fi
if [ -e "$PAYLOAD_DIR" ] || [ -L "$PAYLOAD_DIR" ]; then
  if ! mv "$PAYLOAD_DIR" "$PAYLOAD_BACKUP_DIR"; then
    echo "install failed: could not move existing payload $PAYLOAD_DIR aside" >&2
    exit 1
  fi
fi
if ! mv "$PAYLOAD_STAGE_DIR" "$PAYLOAD_DIR"; then
  echo "install failed: could not activate new payload $PAYLOAD_DIR" >&2
  if [ -e "$PAYLOAD_BACKUP_DIR" ] || [ -L "$PAYLOAD_BACKUP_DIR" ]; then
    mv "$PAYLOAD_BACKUP_DIR" "$PAYLOAD_DIR" 2>/dev/null || true
  fi
  exit 1
fi
PAYLOAD_STAGE_DIR=""
if ! run_payload_migrations "$PAYLOAD_DIR"; then
  echo "install failed: payload migration failed" >&2
  rm -rf "$PAYLOAD_DIR"
  if [ -e "$PAYLOAD_BACKUP_DIR" ] || [ -L "$PAYLOAD_BACKUP_DIR" ]; then
    mv "$PAYLOAD_BACKUP_DIR" "$PAYLOAD_DIR" 2>/dev/null || true
  fi
  exit 1
fi
CURRENT_LINK="$INSTALL_DIR/payloads/current"
CURRENT_STAGE_LINK="$INSTALL_DIR/payloads/.current.tmp.$$"
rm -f "$CURRENT_STAGE_LINK"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  echo "install failed: current payload path is not a symlink: $CURRENT_LINK" >&2
  rm -rf "$PAYLOAD_DIR"
  if [ -e "$PAYLOAD_BACKUP_DIR" ] || [ -L "$PAYLOAD_BACKUP_DIR" ]; then
    mv "$PAYLOAD_BACKUP_DIR" "$PAYLOAD_DIR" 2>/dev/null || true
  fi
  exit 1
fi
if ! ln -s "$PAYLOAD_NAME" "$CURRENT_STAGE_LINK"; then
  echo "install failed: could not update current payload symlink" >&2
  rm -f "$CURRENT_STAGE_LINK"
  rm -rf "$PAYLOAD_DIR"
  if [ -e "$PAYLOAD_BACKUP_DIR" ] || [ -L "$PAYLOAD_BACKUP_DIR" ]; then
    mv "$PAYLOAD_BACKUP_DIR" "$PAYLOAD_DIR" 2>/dev/null || true
  fi
  if [ -n "$PREVIOUS_CURRENT" ] && [ ! -L "$CURRENT_LINK" ]; then
    ln -s "$PREVIOUS_CURRENT" "$CURRENT_LINK" 2>/dev/null || true
  fi
  exit 1
fi
if ! replace_symlink_path "$CURRENT_STAGE_LINK" "$CURRENT_LINK"; then
  echo "install failed: could not update current payload symlink" >&2
  rm -f "$CURRENT_STAGE_LINK"
  rm -rf "$PAYLOAD_DIR"
  if [ -e "$PAYLOAD_BACKUP_DIR" ] || [ -L "$PAYLOAD_BACKUP_DIR" ]; then
    mv "$PAYLOAD_BACKUP_DIR" "$PAYLOAD_DIR" 2>/dev/null || true
  fi
  if [ -n "$PREVIOUS_CURRENT" ] && [ ! -L "$CURRENT_LINK" ]; then
    ln -s "$PREVIOUS_CURRENT" "$CURRENT_LINK" 2>/dev/null || true
  fi
  exit 1
fi
rm -rf "$PAYLOAD_BACKUP_DIR"
prune_old_payloads "$INSTALL_DIR/payloads" "$PAYLOAD_NAME" "$PREVIOUS_CURRENT" "$PAYLOAD_RETENTION" || exit $?

OBU_SHIM_STAGE="$(mktemp "$INSTALL_DIR/bin/.obu.tmp.XXXXXX")"
cat > "$OBU_SHIM_STAGE" <<'SHIM'
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
if ! chmod 755 "$OBU_SHIM_STAGE"; then
  echo "install failed: could not chmod staged shim" >&2
  rm -f "$OBU_SHIM_STAGE"
  exit 1
fi
if [ -L "$OBU_SHIM_PATH" ]; then
  echo "install failed: shim path became a symlink: $OBU_SHIM_PATH" >&2
  rm -f "$OBU_SHIM_STAGE"
  exit 1
fi
if [ -e "$OBU_SHIM_PATH" ] && [ ! -f "$OBU_SHIM_PATH" ]; then
  echo "install failed: shim path is not a regular file: $OBU_SHIM_PATH" >&2
  rm -f "$OBU_SHIM_STAGE"
  exit 1
fi
if ! mv -f "$OBU_SHIM_STAGE" "$OBU_SHIM_PATH"; then
  echo "install failed: could not write shim $OBU_SHIM_PATH" >&2
  rm -f "$OBU_SHIM_STAGE"
  exit 1
fi

OBU_ALIAS_PATH="$INSTALL_DIR/bin/open-browser-use"
OBU_ALIAS_STAGE="$INSTALL_DIR/bin/.open-browser-use.tmp.$$"
rm -f "$OBU_ALIAS_STAGE"
if [ -e "$OBU_ALIAS_PATH" ] && [ ! -L "$OBU_ALIAS_PATH" ] && [ ! -f "$OBU_ALIAS_PATH" ]; then
  echo "install failed: open-browser-use alias path is not a regular file or symlink: $OBU_ALIAS_PATH" >&2
  exit 1
fi
if ! ln -s obu "$OBU_ALIAS_STAGE"; then
  echo "install failed: could not stage open-browser-use alias" >&2
  rm -f "$OBU_ALIAS_STAGE"
  exit 1
fi
if [ -e "$OBU_ALIAS_PATH" ] || [ -L "$OBU_ALIAS_PATH" ]; then
  if [ -d "$OBU_ALIAS_PATH" ] && [ ! -L "$OBU_ALIAS_PATH" ]; then
    echo "install failed: open-browser-use alias path is a directory: $OBU_ALIAS_PATH" >&2
    rm -f "$OBU_ALIAS_STAGE"
    exit 1
  fi
  if ! rm -f "$OBU_ALIAS_PATH"; then
    echo "install failed: could not replace open-browser-use alias $OBU_ALIAS_PATH" >&2
    rm -f "$OBU_ALIAS_STAGE"
    exit 1
  fi
fi
if ! mv "$OBU_ALIAS_STAGE" "$OBU_ALIAS_PATH"; then
  echo "install failed: could not install open-browser-use alias" >&2
  rm -f "$OBU_ALIAS_STAGE"
  exit 1
fi
log_verbose "shim: wrote $OBU_SHIM_PATH"

if [ -n "$SELECTED_TARGET" ]; then
  echo "Selected target: $SELECTED_TARGET"
fi
echo "open-browser-use installed at $INSTALL_DIR"
echo "Run: $INSTALL_DIR/bin/obu bootstrap --yes --all --agents=auto"
if should_modify_path; then
  configure_path
  print_path_activation
else
  log_verbose "path: skipped (modify-path disabled)"
fi
