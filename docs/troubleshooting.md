# open-browser-use Troubleshooting

Start with:

```bash
obu doctor
obu doctor --json
```

Use strict mode in CI:

```bash
obu doctor --strict --json
```

Without `--strict`, `obu doctor` exits nonzero only when a check fails. With
`--strict`, warnings also produce a nonzero exit so CI can reject drift such as
stale extension paths, stale runtime descriptors, or leftover generated backups.

## Runtime Directory

open-browser-use uses one runtime directory for the CLI, native host, extension
descriptors, and MCP entrypoint.

Resolution order:

1. `OBU_RUNTIME_DIR`
2. `~/.obu/config.json`
3. Linux `$XDG_RUNTIME_DIR/obu`, otherwise `/tmp/obu-<uid>`

The directory must be owner-only and must not be a symlink. Repairable
permission issues can be fixed by rerunning setup or:

```bash
obu doctor browser --repair
```

## MCP Stdio Exits Before Starting

`obu mcp stdio` intentionally never runs setup, prints prompts, or writes
first-run help to stdout. If runtime state is missing, it exits nonzero and
writes a short error to stderr.

Run:

```bash
obu setup --yes
obu doctor
```

Then retry the MCP client.

## Extension Loaded From The Wrong Path

The unpacked extension path should be stable:

```text
~/.obu/extension/current
```

If doctor reports loaded-path drift, remove the old unpacked extension from
`chrome://extensions` and load the stable `current` directory, or click Reload
for the already-loaded stable extension after:

```bash
obu update-extension
```

## Native Host Problems

Reinstall native-host manifests and wrappers:

```bash
obu install-host --browser chrome
obu install-host --all
```

The manifest path should point at an open-browser-use wrapper under
`~/.obu/native-host/dev.obu.host/<browser>/obu-host-wrapper`, not directly at a
source-tree helper or versioned payload binary.

## Extension Debug Logs

The unpacked extension popup has local debug logging controls. Open the
open-browser-use extension popup, enable **Debug logs**, reproduce the issue,
then click **Copy** to copy a JSON report with the current popup status and the
recent extension service-worker events. Click **Clear** after collecting the
report.

Logs stay in `chrome.storage.local` and are not uploaded. Keep debug logging
off when you are not actively reproducing an issue.

## Agent Adapter Backups

Direct-edit adapters retain only open-browser-use timestamped backups. To inspect counts:

```bash
obu doctor
```

To remove open-browser-use-generated backups:

```bash
obu doctor --clean-backups
```

User-named backup files are ignored.

## Preview Install Artifacts

P4 preview artifacts are local or GitHub Release artifacts until the public npm
scope is verified. The curl-style preview install path is GitHub Release assets,
not a dedicated website URL. The planned release repository name is
`open-browser-use`.
