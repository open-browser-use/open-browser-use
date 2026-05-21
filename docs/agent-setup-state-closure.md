# Agent Setup State Closure

Date: 2026-05-19

Status: the agent setup closure branch implements CLI-level `obu verify` as the
canonical readiness surface. This document also records the stronger
agent-runtime verification contract. The current build registers a Codex CLI
trusted runtime hook through OBU-owned runtime state; unsupported agents still
report `agent_runtime_hook_unavailable` once CLI readiness is proved, and
user-supplied status files remain diagnostic-only. Existing `obu setup`, `obu
doctor browser`, and `obu agent doctor` commands remain mutating setup or
lower-level diagnostics rather than the canonical readiness surface described
here.

## Product Contract

open-browser-use owns one readiness question end to end:

> Is the selected agent/browser pair ready at the requested verification level?

The product answer must come from one canonical verification surface, not from a
user or agent stitching together partial signals from install logs,
`obu setup`, `obu doctor browser`, `obu agent doctor`, MCP `browser_status`, and
the extension popup.

In a runnable OBU CLI, the canonical surface is:

```bash
obu verify --agent=<agent-id> --browser=<browser> --channel=<channel> --extension-id=<id>
```

By default, `obu verify` answers CLI-level readiness for the selected agent's
durable configuration and the selected browser backend. Agent-runtime readiness
is a stronger target and must be requested explicitly, for example with
`--require-agent-runtime`. Trusted agent-runtime hook evidence can satisfy that
target, but it must not implicitly change the requested target. The JSON always
states which target was used.

It returns exactly one high-level result:

- `ready`: OBU has verified readiness for the requested target. For
  `verificationTarget: "cli"`, this means CLI-level readiness is complete for
  the selected agent config and browser, including a live browser backend
  descriptor and a direct OBU MCP runtime status with at least one usable
  backend. For `verificationTarget: "agent_runtime"`, the selected agent
  runtime has also proved at least one usable backend through OBU MCP status.
- `needs_browser_popup`: local setup is correct, but the selected Chromium-family
  browser has not activated the extension/native-host runtime descriptor yet.
- `needs_repair`: OBU found a deterministic repair it can apply with an
  explicit repair command.
- `needs_manual_action`: the remaining action is outside safe CLI control.

The command returns exactly one next action for every non-ready result. The user
or agent should never have to infer what to do next from multiple successful but
incomplete checks.

There is one pre-CLI exception: if no runnable OBU CLI exists, `obu verify`
cannot be invoked. In that state, the extension handoff, installer, or agent
install prompt owns the preflight result and must return the same product result
shape at the handoff level:

- `result: "needs_manual_action"`
- `nextAction.kind: "install_cli"`
- install command or official install URL

After `obu verify` is available, all readiness answers flow through it.

## Why This Exists

Clean-install feedback exposed state mismatches across the setup flow:

- The extension handoff can tell agents to use `~/.obu/bin/obu`, but a fresh
  machine may not have the CLI installed yet.
- Human agent names such as `codex`, `claude`, and `gemini` can differ from OBU
  adapter ids such as `codex-cli`, `claude-code`, and `gemini-cli`.
- `setup --agents=auto` can configure one path while `agent doctor` checks a
  different path.
- Browser pairing can be repaired on disk while the browser has not activated the
  WebExtension runtime descriptor.
- MCP server availability and browser backend availability are separate states,
  but agents often treat them as one status.
- Opening the extension popup can be required to wake the MV3 extension runtime,
  but the current wording can make that look like a workaround instead of a
  browser lifecycle boundary.

State closure means OBU turns these partial facts into one truthful result and
one precise next action.

## Verification Evidence Model

`obu verify` is a normalization surface before it is a formatter. Each lower
level signal must be converted into a check that states:

- the target it applies to: agent, browser, channel, extension id, and profile
  when profile-scoped;
- the evidence source and provenance;
- the scope that evidence can prove;
- whether the check blocks CLI readiness, agent-runtime readiness, or neither;
- the candidate next action if the check blocks readiness.

The product result must never promote evidence beyond the scope it actually
proves.

Evidence scopes:

- `cli`: local OBU files, selected agent durable config, selected browser
  configuration, runtime descriptor probes, and direct OBU MCP probes.
- `browser_extension`: a live WebExtension backend proves only the selected
  browser and extension id unless profile identity is also present.
- `profile`: descriptor metadata or a direct popup/native-host status source
  identifies the resolved browser profile.
- `agent_runtime`: the selected running agent process has reloaded the
  `open-browser-use` MCP server and reports a usable backend through a trusted
  first-class agent-runtime hook.

Evidence provenance:

- `runtime_descriptor_probe`: OBU probed a local runtime descriptor directly.
- `expected_obu_invocation`: OBU launched or probed the expected OBU MCP
  invocation for the current runtime layout.
- `agent_runtime_hook`: a trusted first-class integration with the selected
  running agent process supplied the status.
- `user_supplied_status_file`: a local file was supplied by the user or an
  agent-mediated workflow. A challenge-bound file can be useful diagnostic
  evidence, but by itself it does not prove that the selected running agent
  process produced the payload.
- `not_applicable`: no runtime evidence was collected for that field.

Only evidence with sufficient scope and provenance can advance the corresponding
readiness field. A direct MCP probe can make `readiness.cli` ready but cannot
make `readiness.agentRuntime` ready. A user-supplied status file without trusted
agent-runtime provenance must not be reported as `source: "agent_runtime"` and
must not make `verificationTarget: "agent_runtime"` return `ready`.

Every blocking check may emit an `actionCandidate`. Result selection is
dependency-gated before priority is applied: CLI-blocking candidates are eligible
first, and agent-runtime candidates are considered only after CLI readiness is
ready and `verificationTarget` is `agent_runtime`. Within the eligible blocker
set, the final `nextAction` is selected by result class, action priority, then
verification layer order. This keeps one-next-action behavior derived from the
same evidence that produced the result.

## Verification Layers

Readiness spans ten layers. `obu verify` must evaluate them in a stable order
and report each layer in JSON.

1. **CLI install state**
   - The executing CLI is valid, and the release CLI exists at the expected path
     when verification is running from a packaged install, normally
     `~/.obu/bin/obu`.
   - The binary is executable.
   - `obu --version` returns a parseable version.

2. **Native-host registration**
   - The selected browser has a native messaging manifest.
   - The manifest points at an executable OBU native host.
   - The manifest includes the exact verified extension origin:
     `chrome-extension://<extension-id>/`.
   - Store channel verification must preserve the supplied Store extension id.

3. **Browser profile resolution state**
   - The resolved browser profile exists and can be inspected.
   - Explicit `--profile` input is preserved exactly in JSON and every follow-up
     command.
   - Default profile discovery is deterministic and reports all candidates.
   - Missing profile roots or nonexistent explicit profiles block readiness with
     a profile-selection action before extension installation can be inferred.

4. **Browser extension installation state**
   - The resolved browser profile contains the matching extension id.
   - The extension is enabled.
   - The extension channel and id match the verification target.

5. **Extension runtime state**
   - The selected Chromium-family browser has activated the extension runtime.
   - The extension has connected to native messaging.
   - The popup can expose this as native-host connection state.
   - The CLI must report the evidence source. Outside the popup, runtime
     activation is inferred from runtime descriptor probing; the CLI cannot read
     arbitrary MV3 service-worker state directly.

6. **Runtime descriptor state**
   - The owner-only runtime descriptor directory exists.
   - At least one descriptor is valid JSON.
   - The descriptor points at a socket-like endpoint.
   - The descriptor responds to `getInfo`.
   - The descriptor lifecycle is not stale.
   - WebExtension descriptor metadata must include the selected browser kind and
     exact extension id. `metadata.extension_id` must equal the verification
     `browser.extensionId`; missing, `"unknown"`, or different extension ids do
     not certify WebExtension readiness. This is mandatory for Store-channel
     targets.
   - If verification is profile-scoped, descriptor metadata or a future
     popup/native-host status source must bind the runtime to the resolved
     profile. Without profile identity evidence, the JSON must state that the
     runtime proof is browser/extension-scoped rather than profile-bound.

7. **MCP runtime state**
   - OBU can launch or probe its MCP server directly using the expected OBU
     server command and args for the current layout.
   - Direct MCP probes must not execute a divergent user-managed agent command.
     If agent config is divergent, verification reports the config conflict
     instead of probing that command.
   - MCP status reports `sdk_bootstrap: "available"` in raw MCP status,
     normalized to `sdkBootstrap: "available"` in verify JSON.
   - MCP status reports at least one usable browser backend for the selected
     browser/extension runtime, including verified WebExtension extension
     identity for WebExtension backends.
   - `backends: []` is a blocking state even when the MCP process starts.

8. **Agent MCP state**
   - The target agent is configured to launch an MCP server named
     `open-browser-use`.
   - The server command and args are equivalent to the expected OBU MCP
     invocation for the current runtime layout. For a packaged install this is
     normally:

   ```json
   {
     "name": "open-browser-use",
     "command": "/absolute/path/to/obu",
     "args": ["mcp", "stdio"]
   }
   ```

     Repo or development layouts may be equivalent through `process.execPath`
     plus the CLI entrypoint and `["mcp", "stdio"]`. JSON must report the
     expected invocation shape that was used for equivalence.

9. **Agent instruction state**
   - Where the target agent supports durable instructions, OBU checks whether
     persistent guidance exists to prefer open-browser-use as the primary
     BrowserUse/browser automation tool.
   - This is advisory for default CLI readiness. Missing supported instructions
     are a non-blocking `warn` with `reason: "missing_instruction"` because
     `obu setup` writes instruction files only when the user explicitly requests
     that mutation.

10. **Agent runtime state**
    - Required only for `verificationTarget: "agent_runtime"`.
    - The selected running agent process or session has reloaded the
      `open-browser-use` MCP server.
    - Agent-runtime status came through a trusted first-class hook for the
      selected agent, not through a user-edited file or arbitrary command.
    - The hook status is fresh, challenge-bound, target-bound, and reports at
      least one usable backend with verified extension identity.

Layers 1, 2, 8, and 9 are mostly file/config state. Layer 3 depends on browser
profile discovery. Layer 4 depends on the resolved browser profile's extension
preferences. Layers 5 and 6 depend on the selected browser's extension runtime
activation. Layer 7 depends on packaged runtime dependencies, SDK bootstrap
state, and backend discovery. Layer 10 depends on a trusted selected-agent
runtime integration. The CLI can repair deterministic file/config state, but it
cannot force the browser to keep an MV3 service worker alive or force an agent
process to reload MCP tools.

For CLI verification, extension runtime state is considered active when a
runtime descriptor for the selected browser responds to `getInfo` and
WebExtension descriptor metadata proves the selected extension id. It is considered
inactive when native-host and extension file/config state pass but no fresh
descriptor can be probed. The corresponding check must include
`details.source: "runtime_descriptor_probe"` unless a future popup/native-host
status API supplies a more direct source.

When descriptor metadata cannot prove profile identity, `obu verify` must expose
that limitation explicitly in `browser.profile.runtimeBinding`. It must not
claim profile-bound runtime readiness unless descriptor metadata or a direct
popup/native-host status source identifies the resolved profile. Browser/extension
scoped runtime proof is acceptable for CLI readiness when the selected profile
was explicit or default discovery found exactly one matching profile, but human
output must not imply stronger profile-specific proof.

For profile-scoped verification, runtime proof is explicit:

- If `--profile=<path>` is supplied and the runtime cannot be bound to that
  profile, `result: "ready"` is still allowed only at browser/extension scope.
  JSON must set `browser.profile.runtimeBinding: "browser_extension_scope"` and
  include a non-blocking `browser_profile` warning with
  `reason: "profile_runtime_not_bound"`.
- If default discovery finds multiple matching profiles, `result: "ready"`
  requires `profile_verified`; otherwise return `needs_manual_action` with
  `nextAction.kind: "select_profile"`. Supplying an explicit `--profile` is one
  way to resolve the ambiguity, but the resulting runtime proof may still be
  browser/extension-scoped unless a future profile identity source exists.
  Deterministic sorting may produce a suggested profile, but suggestion is not
  resolution.
- `single_candidate` is only acceptable for CLI readiness when default discovery
  found exactly one matching enabled extension profile.

## Browser Profile Resolution

`obu verify` must make browser profile selection explicit.

Profile resolution order:

1. If `--profile=<path>` is supplied, verify only that profile.
2. If the explicit profile path does not exist or cannot be inspected, keep that
   profile path in JSON, distinguish `missing` from `unreadable`, and return
   `needs_manual_action` with `nextAction.kind: "select_profile"`.
3. If no profile is supplied, use the same default profile discovery as
   `obu doctor browser` for the selected browser.
4. If default discovery cannot find a profile root for the selected browser,
   return `needs_manual_action` with `nextAction.kind: "select_profile"`.
5. If exactly one candidate profile contains the target extension id, resolve
   that profile and continue with extension enabled/runtime checks.
6. If multiple candidate profiles contain the target extension id and runtime
   evidence is `profile_verified`, resolve the verified profile.
7. If multiple candidate profiles contain the target extension id and runtime
   evidence is not `profile_verified`, sort them deterministically, report all
   candidates in JSON, and record a non-authoritative
   `browser.profile.suggestedPath`. Prefer the first enabled matching profile;
   if none are enabled, use the first installed matching profile. Do not treat
   that suggestion as the resolved profile.
8. If an explicit profile is supplied but does not contain the target extension
   id, keep that profile path in JSON and return `needs_manual_action` with
   `nextAction.kind: "install_extension"`.
9. If default discovery finds exactly one inspectable profile but it does not
   contain the target extension id, resolve that profile and return
   `needs_manual_action` with `nextAction.kind: "install_extension"`.
10. If default discovery finds multiple inspectable profiles but none contains the
   target extension id, report all candidates, record the deterministic first
   inspectable profile as `browser.profile.suggestedPath`, and return
   `needs_manual_action` with `nextAction.kind: "select_profile"`.

Profile existence and extension installation are separate states. Do not tell a
user to install the extension into a profile that OBU could not find or inspect;
first ask them to create, launch, or select the intended profile.

Default discovery must sort candidate profile directories deterministically:
`Default` first, `Profile <number>` in numeric order, then all other profile
directories lexicographically by absolute path. `readdir` order is not a product
contract.

Profile action derivation uses this matrix:

| Default-discovered profile state | `browser.profile.path` | `browser.profile.suggestedPath` | Next action |
| --- | --- | --- | --- |
| `0` inspectable profiles | `null` | `null` | `select_profile` |
| `1` inspectable profile, target extension missing | resolved profile | `null` | `install_extension` |
| `N` inspectable profiles, target extension missing everywhere | `null` | first inspectable profile | `select_profile` |
| `1` profile with target extension installed but disabled | resolved profile | `null` | `enable_extension` |
| `N` profiles with target extension installed, none enabled | `null` | first installed matching profile | `select_profile` |
| `N` profiles with target extension installed, one or more enabled, no `profile_verified` runtime proof | `null` | first enabled matching profile | `select_profile` |
| `N` profiles with target extension installed and `profile_verified` runtime proof | verified profile | `null` | continue runtime readiness checks |

The invariant is that `N` profile ambiguity returns `select_profile` unless
runtime evidence identifies one verified profile. `install_extension` and
`enable_extension` are emitted only after a single profile has been resolved.
`browser.profile.path` and `browser.profile.suggestedPath` are mutually
exclusive: when `browser.profile.path` is non-null,
`browser.profile.suggestedPath` must be `null`. Diagnostic alternatives belong
in `browser.profile.candidates[]`, not in `suggestedPath`.

This requires a verify-specific profile resolver. Reusing lower-level browser
doctor code is acceptable only if the resulting implementation supports explicit
`--profile`, deterministic candidate ordering, candidate reporting, disabled
extension state, and preservation of profile context in follow-up commands.

The JSON response must include:

- `browser.profile.path`: selected/resolved profile path or `null`. It is the
  explicit profile, the only matching default-discovered profile, the only
  inspectable default-discovered profile when the next action is to install the
  extension there, or a profile-verified runtime target. It must be `null` when
  default discovery is ambiguous and runtime evidence is not profile-bound.
- `browser.profile.suggestedPath`: string path or `null`; deterministic first
  profile OBU can suggest when default discovery is ambiguous. For multiple
  matching extensions this is the first enabled matching candidate. For multiple
  matching extensions with no enabled candidate this is the first installed
  matching candidate. For multiple inspectable profiles with no installed target
  extension this is the first inspectable profile. It is not a resolved profile
  and must be `null` whenever `browser.profile.path` is non-null.
- `browser.profile.source`: `explicit | default_discovery`
- `browser.profile.candidates`: array of candidate objects with `path`,
  `profileExists`, `extensionInstalled`, `extensionEnabled`, and optional
  `reasons` keyed by those field names when any candidate field is not `pass`
- `browser.profile.runtimeBinding`: `profile_verified | single_candidate |
  browser_extension_scope | not_available`

Top-level `browser.extensionInstalled` and `browser.extensionEnabled` summarize
the selected/resolved profile only. If no profile is resolved, or if the selected
profile cannot be inspected, both fields must be `not_checked` with
`browser.reasons.extensionInstalled` and `browser.reasons.extensionEnabled`. If a
resolved profile lacks the extension, `browser.extensionInstalled` must be
`missing`, `browser.extensionEnabled` must be `not_checked`, and both fields must
have `browser.reasons.extensionInstalled` and
`browser.reasons.extensionEnabled`.

`browser.profile.runtimeBinding` values mean:

- `profile_verified`: descriptor metadata or direct popup/native-host status
  identifies the resolved profile.
- `single_candidate`: default discovery found exactly one matching profile, and
  the runtime descriptor matches the selected browser and extension id but does
  not expose profile identity.
- `browser_extension_scope`: runtime proof matches only the selected browser and
  extension id. Human output must not describe this as profile-bound readiness.
- `not_available`: no runtime descriptor or status source is available.

If an explicit profile is supplied and the path does not exist,
`browser.profile.path` must keep the explicit path, `browser.profile.source` must
be `explicit`, `browser.profile.suggestedPath` must be `null`, and
`browser.profile.candidates` must contain only that path with
`profileExists: "missing"`, `extensionInstalled: "not_checked"`, and
`extensionEnabled: "not_checked"`. The candidate must include
`browser.profile.candidates[].reasons.profileExists`,
`browser.profile.candidates[].reasons.extensionInstalled`, and
`browser.profile.candidates[].reasons.extensionEnabled` explaining that extension
state cannot be inspected until the profile exists.
`nextAction.kind` must be `select_profile`.

If an explicit profile path exists but cannot be inspected,
`browser.profile.path` must keep the explicit path and the candidate must use
`profileExists: "unreadable"`, with `extensionInstalled: "not_checked"` and
`extensionEnabled: "not_checked"` plus per-field reasons for all three fields.
The blocking `browser_profile` check must include a specific reason such as
`profile_unreadable` or `profile_preferences_unreadable`. `nextAction.kind` must
be `select_profile`.

If an explicit profile is supplied and does not contain the target extension id,
`browser.profile.path` must keep the explicit path,
`browser.profile.source` must be `explicit`, `browser.profile.candidates` must
contain only that path with `profileExists: "pass"`,
`extensionInstalled: "missing"`, and `extensionEnabled: "not_checked"`. The
candidate must include
`browser.profile.candidates[].reasons.extensionInstalled` and
`browser.profile.candidates[].reasons.extensionEnabled` explaining that
enablement was not inspected because the extension is missing. Top-level
`extensionInstalled` must be `missing`, and top-level `extensionEnabled` must be
`not_checked`, with `browser.reasons.extensionInstalled` and
`browser.reasons.extensionEnabled`. `nextAction.kind` must be
`install_extension`.

If default discovery cannot find or inspect the selected browser profile root,
`browser.profile.path` must be `null`, `browser.profile.source` must be
`default_discovery`, `browser.profile.suggestedPath` must be `null`,
`browser.profile.candidates` must be an empty array, `extensionInstalled` must be
`not_checked`, `extensionEnabled` must be `not_checked`,
`browser.reasons.extensionInstalled` and `browser.reasons.extensionEnabled` must
explain that no profile can be inspected, and the blocking `browser_profile`
check must include `reason: "profile_root_missing"`,
`reason: "profile_root_unreadable"`, or a more specific inspection failure
reason. `nextAction.kind` must be `select_profile`.

If default discovery finds exactly one inspectable browser profile but it does
not contain the target extension id, `browser.profile.path` must contain that
profile path, `browser.profile.source` must be `default_discovery`,
`browser.profile.suggestedPath` must be `null`, `browser.profile.candidates`
must include that profile, `extensionInstalled` must be `missing`, and
`extensionEnabled` must be `not_checked`, with
`browser.reasons.extensionInstalled` and `browser.reasons.extensionEnabled`.
`nextAction.kind` must be `install_extension`.

If default discovery finds multiple inspectable browser profiles but no
candidate profile containing the target extension id, `browser.profile.path` must
be `null`, `browser.profile.source` must be `default_discovery`,
`browser.profile.suggestedPath` must contain the deterministic first inspectable
profile, `browser.profile.candidates` must include all inspected profile paths,
`extensionInstalled` must be `not_checked`, `extensionEnabled` must be
`not_checked`, `browser.reasons.extensionInstalled` and
`browser.reasons.extensionEnabled` must explain that profile choice is ambiguous,
and `nextAction.kind` must be `select_profile`. The human message should ask the
user to choose the profile before installing the extension.

If default discovery finds multiple matching profiles and no profile-bound
runtime proof is available, `browser.profile.path` must be `null`,
`browser.profile.suggestedPath` must contain the deterministic first enabled
matching profile, or the deterministic first installed matching profile when no
matching profile is enabled. All candidates must be reported, and
`nextAction.kind` must be `select_profile`.

If a matching extension is present but disabled in the resolved profile,
`extensionInstalled` must be `pass`, `extensionEnabled` must be `disabled`, and
the candidate must include
`browser.profile.candidates[].reasons.extensionEnabled`. The browser summary
must include `browser.reasons.extensionEnabled`. `nextAction.kind` must be
`enable_extension`.

When `--profile=<path>` is supplied, every generated rerun, repair, or follow-up
command must preserve that exact `--profile` value. Default-discovery commands
may omit `--profile` only when profile choice is deterministic and not material
to the result.

Human output should name the resolved profile only when profile choice affects
the result or there are multiple candidates.

## Readiness Levels

`obu verify` reports two levels of readiness.

The top-level JSON field `verificationTarget` must be one of:

- `cli`: default target. The command verifies local setup, selected agent
  durable config, a live browser backend descriptor, and direct OBU MCP runtime
  status with at least one usable backend.
- `agent_runtime`: stronger target. The command verifies CLI readiness and a
  status result from the selected, currently running agent process.

### CLI-Level Readiness

CLI-level readiness means OBU can verify local setup and a live browser backend
without relying on a specific agent process.

Required evidence:

- Native-host manifest is valid for the exact extension id.
- Browser extension is installed and enabled in the resolved profile.
- Runtime descriptor responds to `getInfo`.
- `browser.profile.runtimeBinding` is strong enough for the selected profile
  mode: `profile_verified`, `browser_extension_scope` with a
  `profile_runtime_not_bound` warning for explicit profile verification, or
  `single_candidate` for default discovery with exactly one matching profile.
- `resumeRequired` is `false`.
- `mcpRuntime.cli` has `source: "direct_mcp_probe"`, `mcpStarts: true`,
  `sdkBootstrap: "available"`, and `backendCount > 0`.
- At least one usable WebExtension backend in `mcpRuntime.cli.backends` has
  normalized extension identity matching the selected `browser.extensionId`.
- Agent MCP config is equivalent to the expected OBU server.
- Agent instruction check is either `pass` or a non-blocking `warn` with
  `reason: "not_implemented"` or `reason: "missing_instruction"`.

### Agent-Runtime Readiness

Agent-runtime readiness is stronger. It means the selected agent has reloaded
its MCP tools and its own OBU MCP status reports at least one usable backend.

Required evidence:

- CLI-level readiness is complete.
- Status came from the selected running agent process through a trusted
  first-class agent-runtime hook with `provenance: "agent_runtime_hook"`.
- The hook transport is trusted for the selected agent, such as
  `agent_connector`, `agent_owned_ipc`, or `in_process_adapter`.
- The hook identity is registered for the selected canonical `agentId`, and
  `hook.trusted` is derived by OBU from registry and transport validation rather
  than accepted from payload fields.
- The status envelope is fresh, challenge-bound, and target-bound to the selected
  agent, MCP server name, browser, channel, extension id, and explicit profile
  value when one was supplied.
- `mcpRuntime.agentRuntime` has `source: "agent_runtime"`,
  `sdkBootstrap: "available"`, and at least one usable WebExtension backend with
  verified extension identity matching `browser.extensionId`.

An MCP server with `backends: []` is not ready for browser automation. It only
proves that the MCP process can start.

When agent-runtime status cannot be checked from the CLI, `obu verify` must set
`agent.runtimeStatus.status: "not_checked"` and still provide CLI-level
readiness. It must not silently imply agent-runtime readiness.

With `verificationTarget: "cli"`, `result: "ready"` is allowed when CLI-level
readiness is complete and agent-runtime readiness is `not_checked`. Human output
must call this CLI-level readiness, and JSON must keep
`readiness.agentRuntime: "not_checked"` so agents can distinguish "CLI verified"
from "the current agent process has reloaded and proved a backend through MCP."

With `verificationTarget: "agent_runtime"`, `result: "ready"` is allowed only
when `readiness.agentRuntime` is `ready`. If agent-runtime status is unavailable,
not checked, or checked with zero usable backends, the result must not be
`ready`.

## Command Surface

### Read-Only Verification

Default verification is read-only:

```bash
obu verify \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

Store-channel handoff, repair, and generated verification commands must include
the exact `--channel=store` and `--extension-id=<id>` values from the handoff.
`obu verify --agent=<agent-id>` may omit browser/channel/extension arguments only
when OBU can resolve them from trusted local state, and JSON must report the
resulting `browser.channel`, `browser.extensionId`, and `browser.extensionIdSource`.
For Store readiness, `extensionIdSource` is part of the readiness evidence, not a
diagnostic aside. Human handoff output should still prefer the full command even
when omission would work.

To verify a specific browser profile, add:

```bash
obu verify \
  --agent=codex-cli \
  --browser=chrome \
  --profile="/Users/alex/Library/Application Support/Google/Chrome/Default" \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

Read-only verification may inspect files, execute OBU binaries, probe runtime
descriptors, and run read-only agent status commands. It must not write config,
repair native-host manifests, create instruction files, or mutate agent MCP
config.

Read-only direct MCP probing must execute only OBU-owned expected invocations for
the selected runtime layout. It must not execute an arbitrary command read from a
divergent or unreadable agent config.

To require proof from the selected running agent process, use:

```bash
obu verify --require-agent-runtime \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

This sets `verificationTarget: "agent_runtime"`. If OBU cannot obtain status
from that agent process, the command must return a non-ready result with a
single action such as restarting/reloading the agent or running the registered
agent-runtime hook from inside the selected client.

Agent-runtime proof must come from a first-class agent-runtime status hook, not
from a direct OBU MCP probe and not from a user-supplied status file.

A trusted hook is a compiled or registered OBU agent-adapter capability for the
selected canonical agent id. It is not read from the agent's MCP config, project
instructions, shell aliases, or a user-editable JSON path. A hook is trusted only
when all of these are true:

- OBU knows the hook implementation for the selected `agentId`.
- The hook communicates with the selected running agent process or session
  through a first-class transport such as `agent_connector`, `agent_owned_ipc`,
  or `in_process_adapter`.
- The hook receives the verification challenge and target from OBU, causes that
  selected agent process to call `browser_status` through its configured
  `open-browser-use` MCP server, and returns the resulting status envelope to
  OBU through the same trusted transport.
- The transport is not an arbitrary command from user config and is not a file
  whose contents can be produced or edited outside the selected agent-runtime
  hook.

The hook payload is the selected agent process's raw `browser_status` structured
content plus envelope fields for freshness, provenance, hook identity, trust
transport, and target binding:

```json
{
  "schemaVersion": 1,
  "agentId": "codex-cli",
  "mcpServerName": "open-browser-use",
  "provenance": "agent_runtime_hook",
  "hook": {
    "id": "codex-cli-runtime-status",
    "transport": "agent_owned_ipc"
  },
  "generatedAt": "2026-05-19T12:34:56.000Z",
  "challenge": {
    "nonce": "verify-issued-random-nonce",
    "issuedAt": "2026-05-19T12:34:30.000Z"
  },
  "target": {
    "browser": "chrome",
    "channel": "store",
    "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
    "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
  },
  "status": {
    "sdk_bootstrap": "available",
    "backends": [
      {
        "type": "webextension",
        "name": "chrome",
        "metadata": {
          "browser_kind": "chrome",
          "extension_id": "fblnfcjnjklpgnmfnngcihbcgojnpadj"
        }
      }
    ]
  }
}
```

The CLI must reject stale, unbound, or unauthoritative agent-runtime payloads as
proof. A payload can make `readiness.agentRuntime` become `ready` only when all
of these are true:

- `generatedAt` is within the freshness window, normally 60 seconds.
- The challenge nonce matches the challenge JSON supplied to this verification
  command, or an equivalent first-class challenge stored by the CLI.
- `provenance` is `agent_runtime_hook`, and the CLI can trust the transport or
  integration that supplied that provenance. A field in a user-edited file is not
  sufficient by itself.
- `hook.id` names a registered OBU hook for `agentId`, and `hook.transport` is
  one of the trusted transports for that hook. `hook.trusted` is derived by OBU
  from registry and transport validation; it must not be accepted from the
  payload.
- `agentId`, `mcpServerName`, browser, channel, extension id, and explicit
  profile value match the verification target.
- At least one WebExtension backend in the status payload has normalized
  extension identity proving `extensionId === browser.extensionId`; metadata-less
  or `"unknown"` WebExtension backends do not count as usable for a selected
  extension id.

Raw `browser_status` output or a standalone status JSON without a fresh matching
challenge is diagnostic evidence only; it must not produce
`verificationTarget: "agent_runtime"` / `result: "ready"`.

When a trusted hook implementation and transport are registered for the selected
agent, the normal command is still:

```bash
obu verify --require-agent-runtime \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

OBU invokes the registered hook, validates the returned envelope, derives
`agent.runtimeStatus.hook.trusted: true`, and reports
`mcpRuntime.agentRuntime.source: "agent_runtime"` only for trusted hook evidence.
If this OBU build has no registered trusted hook for the selected agent, the
command must return `agent_runtime_hook_unavailable`; it must not emit a
`trustedHook` object or write a challenge file for an unimplemented transport.

Some hooks may need a user-mediated in-agent collection step after CLI readiness
passes. In that case OBU issues a challenge for the trusted hook, not for an
arbitrary status file:

```bash
obu verify --require-agent-runtime \
  --agent-runtime-challenge-out=/path/to/challenge.json \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj

# The selected agent runs the registered OBU agent-runtime hook for this
# challenge. The hook calls browser_status through the selected agent's configured
# OBU MCP server and returns the envelope through the trusted hook transport.
```

For Codex CLI, the registered collection hook is the OBU MCP tool
`agent_runtime_status`. The agent calls it with the challenge JSON path; the MCP
server calls `browser_status`, writes the envelope to OBU-owned runtime state,
and the follow-up `obu verify --require-agent-runtime
--agent-runtime-challenge-json=<path>` reads only that deterministic state path.
The diagnostic `--agent-runtime-status-json` flag is not this transport.

A later verification pass may reference the challenge, but readiness can become
`ready` only when the registered hook supplies the matching envelope through its
trusted transport. The `--agent-runtime-status-json` flag is not that mechanism.

Trusted hook result retrieval uses the hook registry, not a user-provided status
file. A registered hook may satisfy verification in either of these ways:

- `invokeStatus(challenge, target)` returns the status envelope synchronously
  through the trusted transport.
- `readChallengeResult(challenge, target)` retrieves a result that the hook
  previously delivered through the trusted transport into OBU-owned runtime
  state. The state must be bound to the challenge nonce, selected `agentId`,
  target browser/channel/extension/profile, hook id, and trusted transport. OBU
  must ignore result files or handles that were not created by the registered
  hook transport.

The follow-up command for a user-mediated trusted hook collection is:

```bash
obu verify --require-agent-runtime \
  --agent-runtime-challenge-json=/path/to/challenge.json \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

The file-based status surface is diagnostic only. It exists for development,
tests, and support bundles:

```bash
obu verify --require-agent-runtime \
  --agent-runtime-challenge-json=/path/to/challenge.json \
  --agent-runtime-status-json=/path/to/status.json \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

`--agent-runtime-status-json` is a file transport, not a trust mechanism. If the
payload is only a user-supplied status file, verification must report
`agent.runtimeStatus.provenance: "user_supplied_status_file"` and
`mcpRuntime.agentRuntime.source: "agent_runtime_status_file"`, then treat it as
diagnostic evidence only. Only a trusted first-class hook can report
`agent.runtimeStatus.provenance: "agent_runtime_hook"` and
`mcpRuntime.agentRuntime.source: "agent_runtime"` to make
`readiness.agentRuntime` ready.

The challenge-out command is a challenge-issuance verification pass only when a
trusted hook is registered. If CLI-level readiness is blocked, it returns the
normal blocking result and may omit the challenge file. If no trusted hook is
registered for the selected agent, it returns `agent_runtime_hook_unavailable`
and must not write a challenge file. If CLI-level readiness is complete, a
trusted hook is registered, and the challenge file is written, but no valid
trusted hook payload has been supplied yet, the command returns:

- exit code `1`;
- `result: "needs_manual_action"`;
- `readiness.cli: "ready"`;
- `readiness.agentRuntime: "blocked"`;
- `agent.runtimeStatus.status: "not_checked"`;
- `agent.runtimeStatus.reason: "agent_runtime_challenge_issued"`;
- `nextAction.kind: "collect_agent_runtime_status"`;
- `nextAction.challenge.path`: the challenge JSON path.
- `nextAction.trustedHook.id`: the hook that must collect the status.

This is a pending agent-runtime proof state, not a failed local setup state.

If `--require-agent-runtime` is set and no valid hook payload is supplied,
`agent.runtimeStatus.status` must be `not_checked`,
`readiness.agentRuntime` must be `blocked`, and the result must not be `ready`.
The blocking check must use `checks[].layer: "agent_runtime"`,
`blocks: ["agent_runtime"]`, and an `actionCandidate` for
`unsupported`, `collect_agent_runtime_status`, `restart_agent`, or
`configure_agent` as appropriate.

### Explicit Repair

Repair requires an explicit flag:

```bash
obu verify --repair \
  --agent=codex-cli \
  --browser=chrome \
  --channel=store \
  --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

`--repair` may apply deterministic OBU-owned repairs:

- create or repair native-host manifests;
- fix allowed extension origins;
- fix native-host binary paths;
- create owner-only runtime directories;
- remove stale or invalid runtime descriptors;
- create or repair first-class auto-writable agent MCP config when no divergent
  user config exists.

`--repair` must not overwrite divergent user-managed agent config. Divergence is
`needs_manual_action`.

### Output Modes

Human output is concise by default. JSON output is stable:

```bash
obu verify --agent=codex-cli --json
```

The default exit codes are:

- `0`: `ready`
- `1`: `needs_browser_popup`, `needs_repair`, or `needs_manual_action`
- `2`: invalid command input, unknown flags, malformed arguments, or platform
  states that prevent verification from running

Valid requests for targets that OBU can inspect but cannot automate still return
exit code `1` with `result: "needs_manual_action"` and
`nextAction.kind: "unsupported"`.

## Agent Identity Contract

OBU accepts common human names but emits canonical ids.

| Input | Canonical id |
| --- | --- |
| `codex` | `codex-cli` |
| `claude`, `claude-cli` | `claude-code` |
| `gemini` | `gemini-cli` |

Canonical ids appear in logs, JSON, and remediation commands.

First-class agent config surfaces:

| Agent | MCP surface | Instruction surface |
| --- | --- | --- |
| `codex-cli` | `~/.codex/config.toml` | project `AGENTS.md`/`AGENT.md`, then `~/.codex/AGENTS.md` |
| `cursor` | `~/.cursor/mcp.json` | not implemented |
| `claude-code` | `claude mcp` | project `CLAUDE.md`, then `~/.claude/CLAUDE.md` |
| `gemini-cli` | `gemini mcp` | not implemented |
| `vscode` | VS Code MCP add command | not implemented |
| `cline` | Cline JSON MCP config | not implemented |
| `windsurf` | Windsurf JSON MCP config | not implemented |
| `claude-desktop` | Claude Desktop JSON MCP config | not implemented |
| `zed` | Zed `context_servers` config | not implemented |
| `continue` | reference/manual config only | not implemented |

Setup and doctor must read and write the same MCP surface for each first-class
agent. OBU must never report an agent as configured through one path while
doctor verifies a different path.

## Result Precedence

Result selection is dependency-gated before result priority is applied.

First, `obu verify` resolves all CLI-level blockers. If any check with
`blocks` containing `cli` is blocking, the selected result and `nextAction` must
come only from CLI-blocking checks. This remains true even when
`verificationTarget: "agent_runtime"` and agent-runtime evidence is missing.
Agent-runtime actions are not actionable until CLI readiness is complete.

Second, if `readiness.cli` is `ready` and
`verificationTarget: "agent_runtime"`, `obu verify` evaluates
agent-runtime blockers and chooses from checks with `blocks` containing
`agent_runtime`.

Third, if every required readiness level is `ready`, the result is `ready`.

Within the eligible blocker set, `obu verify` chooses the highest-priority result
using this order:

1. `needs_manual_action`
2. `needs_repair`
3. `needs_browser_popup`
4. `ready`

Rationale:

- Manual action blocks safe automation and cannot be solved by OBU alone.
- Deterministic repair should be surfaced before popup activation.
- Popup activation only makes sense when local setup is otherwise correct.
- Ready requires all required layers to pass.
- Agent-runtime-required verification adds the agent runtime as a required layer;
  CLI-level readiness alone is not enough for `ready` in that mode.

MCP zero-backend classification happens after descriptor activation is
classified. If local file/config state passes but no fresh runtime descriptor is
active, `backendCount: 0` is treated as downstream evidence of the same popup
activation boundary, and the result is `needs_browser_popup` with
`nextAction.kind: "open_popup"`, not `needs_repair`.

Each blocking check should emit an `actionCandidate` when OBU knows the next
action. After the top-level result is selected, `obu verify` chooses the single
`nextAction` deterministically from those candidates within that result class.

For `needs_manual_action`, action priority is:

1. `install_cli`
2. `unsupported`
3. `resolve_config_conflict`
4. `select_profile`
5. `install_extension`
6. `enable_extension`
7. `collect_agent_runtime_status`
8. `restart_agent`
9. `configure_agent`

`actionCandidate.priority` is a positive integer. It must use the numeric rank
from the priority list for its result class. Lower numbers win. For example,
`select_profile` has priority `4` within `needs_manual_action`.

For `needs_repair`, the `run_repair` command should target the first repairable
blocking layer in verification order. The repair command may repair multiple
deterministic OBU-owned issues, but the human message must name the first
blocking issue that determined the action.

For `needs_repair`, `run_repair` uses priority `1`. For
`needs_browser_popup`, `open_popup` uses priority `1`.

Examples:

- Divergent Codex MCP config plus missing runtime descriptor:
  `needs_manual_action`.
- Missing or ambiguous profile plus missing extension:
  `needs_manual_action` with `select_profile`.
- Native-host manifest missing exact Store id plus no descriptor:
  `needs_repair`.
- Native host and extension are correct, but descriptor is absent:
  `needs_browser_popup`.
- Descriptor responds, direct MCP runtime proves `sdkBootstrap: "available"` with
  at least one identity-matched backend, and agent MCP config is equivalent:
  `ready` when `verificationTarget` is `cli`.
- Descriptor responds and agent MCP config is equivalent, but direct MCP runtime
  status has `backendCount: 0`: `needs_repair` or `needs_manual_action`,
  depending on whether the zero-backend cause is safely repairable.
- Descriptor responds and agent MCP config is equivalent, but
  `--require-agent-runtime` cannot check the running agent:
  `needs_manual_action`.
- CLI readiness passes and a trusted agent-runtime hook has issued a challenge
  but has not returned status yet: `needs_manual_action` with
  `collect_agent_runtime_status`.

## Next Action Contract

Every non-ready result has exactly one `nextAction`.

Action kinds:

- `install_cli`
- `run_repair`
- `open_popup`
- `configure_agent`
- `resolve_config_conflict`
- `restart_agent`
- `collect_agent_runtime_status`
- `select_profile`
- `install_extension`
- `enable_extension`
- `unsupported`

Result/action mapping:

| Condition | Result | Next action kind |
| --- | --- | --- |
| No runnable OBU CLI exists before handoff reaches the CLI | `needs_manual_action` | `install_cli` |
| Explicit profile path does not exist, cannot be inspected, or default discovery cannot find a profile root | `needs_manual_action` | `select_profile` |
| Multiple matching profiles exist but runtime proof is not profile-bound | `needs_manual_action` | `select_profile` |
| Multiple inspectable profiles exist but none contains the selected extension | `needs_manual_action` | `select_profile` |
| Selected extension is not installed in the resolved profile | `needs_manual_action` | `install_extension` |
| Selected extension is installed but disabled in the resolved profile | `needs_manual_action` | `enable_extension` |
| Native-host manifest, allowed origin, host path, runtime permissions, or stale descriptor can be repaired deterministically | `needs_repair` | `run_repair` |
| Missing first-class auto-writable agent MCP config and no divergent config exists | `needs_repair` | `run_repair` |
| Direct MCP runtime cannot start, SDK bootstrap is unavailable, or backend count is zero for a reason repair can fix after descriptor activation has been ruled out | `needs_repair` | `run_repair` |
| Direct MCP runtime cannot start, SDK bootstrap is unavailable, or backend count is zero for a reason outside safe CLI repair after descriptor activation has been ruled out | `needs_manual_action` | `configure_agent` |
| Agent MCP config is missing but cannot be safely written by OBU | `needs_manual_action` | `configure_agent` |
| Existing agent MCP config for `open-browser-use` is divergent or unreadable | `needs_manual_action` | `resolve_config_conflict` |
| CLI-level readiness passes but no trusted agent-runtime hook is registered for the selected agent in this build | `needs_manual_action` | `unsupported` |
| CLI-level readiness passes, a trusted agent-runtime hook is registered, and an agent-runtime challenge has been issued but no valid trusted hook payload is available yet | `needs_manual_action` | `collect_agent_runtime_status` |
| CLI-level readiness passes but `verificationTarget: "agent_runtime"` cannot be proved until the client reloads | `needs_manual_action` | `restart_agent` |
| Local setup is correct but no fresh runtime descriptor is active | `needs_browser_popup` | `open_popup` |
| A syntactically valid platform, browser, or agent target is unsupported by this OBU build | `needs_manual_action` | `unsupported` |

Action derivation sources:

| Next action kind | Required source check layer | Required status | Required `blocks` | Candidate result |
| --- | --- | --- | --- | --- |
| `install_cli` | `cli_install` | `fail` | `["cli"]` | `needs_manual_action` |
| `unsupported` | `target_support` or `agent_runtime` | `fail` | `["cli"]` or `["agent_runtime"]` | `needs_manual_action` |
| `resolve_config_conflict` | `agent_mcp` | `fail` | `["cli"]` | `needs_manual_action` |
| `select_profile` | `browser_profile` | `fail` | `["cli"]` | `needs_manual_action` |
| `install_extension` | `browser_extension` | `fail` | `["cli"]` | `needs_manual_action` |
| `enable_extension` | `browser_extension` | `fail` | `["cli"]` | `needs_manual_action` |
| `collect_agent_runtime_status` | `agent_runtime` | `fail` | `["agent_runtime"]` | `needs_manual_action` |
| `restart_agent` | `agent_runtime` | `fail` | `["agent_runtime"]` | `needs_manual_action` |
| `configure_agent` | `agent_mcp`, `mcp_runtime`, or `agent_runtime` | `fail` | `["cli"]` or `["agent_runtime"]` | `needs_manual_action` |
| `run_repair` | first repairable blocking layer | `fail` | `["cli"]` | `needs_repair` |
| `open_popup` | `extension_runtime`, `runtime_descriptor`, or `mcp_runtime` | `fail` | `["cli"]` | `needs_browser_popup` |

If a selected `nextAction.kind` cannot be traced to one of these source checks,
the implementation is missing a normalized check and must add that check instead
of synthesizing the action in the aggregator.

Each action must include:

- a human message;
- a command when a command is available;
- enough context to preserve browser, channel, agent, and extension id;
- the explicit profile path when verification was profile-scoped;
- no ambiguous extension id inference.

The next action must be directly actionable. It should not say "check docs" if a
specific repair or configuration command is known.

The selected `nextAction` must be traceable to a blocking check's
`actionCandidate`. The aggregator should not synthesize a different action that
cannot be explained by normalized evidence.

When a browser/profile-specific action cannot be represented safely as a shell
command, `command` must be omitted and the action must include explicit context
instead, such as `url`, `browser`, and `profile.path`. A generic operating-system
`open` command is not enough when it may target the wrong browser or profile.

Every `rerun` or repair command emitted after an explicit `--profile` input must
include that same `--profile` argument.

Invalid command input, unknown flags, malformed extension ids, and unsupported
platform states that prevent verification from running are usage errors. They
exit with code `2` and do not produce a normal readiness result. The
`unsupported` next action is reserved for valid requests where OBU can run
verification and determine that the requested target is outside its supported
automation surface.

## JSON Contract

The JSON schema is stable for agents:

`obu verify` JSON uses lower camelCase field names. Lower-level doctor and MCP
payloads may use snake_case, such as `resume_required` or `sdk_bootstrap`, but
verify must normalize those fields to `resumeRequired` and `sdkBootstrap` in its
top-level contract. Raw source payloads may appear only under clearly named
diagnostic fields such as `details.raw`.

Allowed top-level result values:

- `ready`
- `needs_browser_popup`
- `needs_repair`
- `needs_manual_action`

Allowed `verificationTarget` values:

- `cli`
- `agent_runtime`

Allowed `browser.channel` values:

- `unpacked-dev`
- `store`

Allowed `browser.extensionIdSource` values:

- `explicit-argument`
- `environment`
- `user-config`
- `payload-metadata`
- `repo-release-metadata`
- `manifest-key`

Allowed check status values:

- `pass`: the check succeeded.
- `warn`: the check is unsupported or non-blocking.
- `fail`: the check blocks readiness.
- `not_checked`: the check was intentionally skipped or cannot complete from the
  current process without external trusted evidence, and the reason is present.

Every `not_checked` status object must include a non-empty `reason`. Component
summary fields on `browser` or `browser.profile.candidates[]` with any value
other than `pass` must have a sibling `reason` or a
`reasons.<fieldName>` entry on the containing object. Browser-level component
reasons belong under `browser.reasons`.

Allowed readiness values:

- `ready`: this readiness level is verified.
- `blocked`: this readiness level is not ready.
- `not_checked`: this readiness level was not checked from this process.

Allowed component state values for summary fields such as `profileExists`,
`extensionInstalled`, `extensionEnabled`, `nativeHost`, and
`runtimeDescriptor`:

- `pass`: the component is present and valid.
- `warn`: the component has a non-blocking issue.
- `fail`: the component has a blocking issue.
- `missing`: the component is absent.
- `unreadable`: the component exists but cannot be inspected.
- `disabled`: the component exists but is disabled.
- `stale`: the component exists but its lifecycle state is stale.
- `invalid`: the component exists but has invalid shape or contents.
- `not_checked`: the component was intentionally not checked and the reason is
  present on the containing object.

`agent.runtimeStatus` is a discriminated object. Its shape depends on
`provenance` and `reason`; diagnostic and pending states must be as stable as the
trusted success state.

Trusted hook success:

```json
{
  "status": "pass",
  "provenance": "agent_runtime_hook",
  "hook": {
    "id": "codex-cli-runtime-status",
    "transport": "agent_owned_ipc",
    "trusted": true
  },
  "generatedAt": "2026-05-19T12:34:56.000Z",
  "targetBound": true,
  "challengeBound": true
}
```

Allowed `agent.runtimeStatus.status` values are `pass`, `fail`, and
`not_checked`. `pass` is allowed only for trusted hook evidence that can promote
`readiness.agentRuntime` to `ready`. Stale, unbound, user-supplied, or
zero-backend payloads must use `fail` or `not_checked` with a non-empty `reason`.
Allowed `agent.runtimeStatus.hook.transport` values are `agent_connector`,
`agent_owned_ipc`, and `in_process_adapter`. `agent.runtimeStatus.hook.id` must
exist in OBU's compiled trusted agent-runtime hook registry for the selected
`agent.id`. `agent.runtimeStatus.hook.trusted` is an OBU-derived output field;
payload-provided `trusted` values must be ignored.

Trusted hook failure keeps the trusted hook envelope but reports `status: "fail"`
with a machine-readable `reason`, such as `stale_status`, `target_mismatch`,
`challenge_mismatch`, `sdk_bootstrap_missing`, or `zero_backends`. It may include
`targetBound` and `challengeBound` booleans because the transport itself is
trusted.

User-supplied status files are diagnostic only. They must not include a trusted
hook object, and parsed challenge or target matches must stay under
`diagnostic`; top-level `targetBound` and `challengeBound` are reserved for
trusted hook evidence:

```json
{
  "status": "not_checked",
  "provenance": "user_supplied_status_file",
  "reason": "diagnostic_status_file_not_trusted",
  "diagnostic": {
    "statusFile": "/path/to/status.json",
    "targetBound": true,
    "challengeBound": true
  }
}
```

When no trusted hook is registered for the selected agent, agent-runtime proof is
unavailable in this build:

```json
{
  "status": "not_checked",
  "provenance": "not_applicable",
  "reason": "agent_runtime_hook_unavailable"
}
```

Challenge issuance through a registered trusted hook without a returned trusted
hook payload is a pending agent-runtime proof state:

```json
{
  "status": "not_checked",
  "provenance": "not_applicable",
  "reason": "agent_runtime_challenge_issued",
  "trustedHook": {
    "id": "codex-cli-runtime-status",
    "transport": "agent_owned_ipc"
  }
}
```

CLI-target verification that did not request agent-runtime proof is explicitly
not checked:

```json
{
  "status": "not_checked",
  "provenance": "not_applicable",
  "reason": "verification_target_cli"
}
```

Instruction check warnings must use one of these reason values:

```json
{
  "status": "warn",
  "reason": "not_implemented"
}
```

```json
{
  "status": "warn",
  "reason": "missing_instruction"
}
```

They must not introduce separate check statuses named `not_implemented` or
`missing_instruction`.

`checks[]` contains the normalized lower-level evidence used to compute the
result. Check objects use this shape:

```json
{
  "id": "agent-mcp-server",
  "layer": "agent_mcp",
  "status": "pass",
  "blocks": [],
  "reason": "equivalent_config",
  "message": "codex-cli configures open-browser-use",
  "target": {
    "agent": "codex-cli"
  },
  "evidence": {
    "scope": "cli",
    "provenance": "expected_obu_invocation",
    "source": "agent_config_read"
  },
  "details": {
    "path": "/Users/alex/.codex/config.toml"
  }
}
```

`reason` is optional for `pass` checks and required for machine-class
`warn`, `fail`, and `not_checked` checks. Instruction warnings use
`reason: "not_implemented"` or `reason: "missing_instruction"` on the check
object, not a synthetic status value.

Every check must include `target` and `evidence` objects. `target` identifies the
agent, browser, channel, extension id, and profile path that the check applies
to; fields that do not apply may be omitted. `evidence.scope` must be one of the
evidence scopes defined above, `evidence.provenance` must be one of the evidence
provenance values defined above, and `evidence.source` must name the concrete
probe, hook, file, registry, or command class that produced the signal. Raw
payloads still belong under `details.raw`.

`blocks` is optional for pass checks and required for blocking checks. It is an
array containing `cli`, `agent_runtime`, or both. Blocking checks should include
an `actionCandidate` with `kind`, `priority`, and enough command/context fields
to construct the final `nextAction`.

`actionCandidate` uses this shape:

```json
{
  "result": "needs_browser_popup",
  "kind": "open_popup",
  "priority": 1,
  "message": "Open the open-browser-use extension popup."
}
```

`result` must be one of the non-ready result values, `kind` must be one of the
allowed next action kinds, and `priority` must follow the result-class priority
rules above. `message`, `command`, `url`, `browser`, `profile`, `rerun`, and
other context fields may be included when they are needed to construct the final
`nextAction`.

Allowed `checks[].layer` values:

- `target_support`
- `cli_install`
- `native_host`
- `browser_profile`
- `browser_extension`
- `extension_runtime`
- `runtime_descriptor`
- `agent_mcp`
- `agent_instruction`
- `mcp_runtime`
- `agent_runtime`

`target_support` is not a readiness layer. It is used only after command input is
syntactically valid and OBU can run verification, but the requested platform,
browser, agent, hook, or feature is outside this build's supported automation
surface. Invalid command input still exits with code `2` and does not produce a
normal readiness result.

```json
{
  "schemaVersion": 1,
  "command": "verify",
  "verificationTarget": "cli",
  "result": "ready",
  "readiness": {
    "cli": "ready",
    "agentRuntime": "not_checked"
  },
  "agent": {
    "id": "codex-cli",
    "input": "codex",
    "mcpConfig": {
      "status": "pass",
      "path": "/Users/alex/.codex/config.toml",
      "serverName": "open-browser-use",
      "command": "/Users/alex/.obu/bin/obu",
      "args": [
        "mcp",
        "stdio"
      ]
    },
    "instructions": {
      "status": "pass",
      "path": "/Users/alex/.codex/AGENTS.md"
    },
    "runtimeStatus": {
      "status": "not_checked",
      "provenance": "not_applicable",
      "reason": "verification_target_cli"
    }
  },
  "browser": {
    "kind": "chrome",
    "channel": "store",
    "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
    "extensionIdSource": "explicit-argument",
    "profile": {
      "path": "/Users/alex/Library/Application Support/Google/Chrome/Default",
      "suggestedPath": null,
      "source": "default_discovery",
      "runtimeBinding": "single_candidate",
      "candidates": [
        {
          "path": "/Users/alex/Library/Application Support/Google/Chrome/Default",
          "profileExists": "pass",
          "extensionInstalled": "pass",
          "extensionEnabled": "pass"
        }
      ]
    },
    "extensionInstalled": "pass",
    "extensionEnabled": "pass",
    "nativeHost": "pass",
    "runtimeDescriptor": "pass",
    "resumeRequired": false,
    "descriptor": {
      "file": "chrome.json",
      "probe": "getInfo",
      "lifecycle": "fresh"
    }
  },
  "mcpRuntime": {
    "cli": {
      "source": "direct_mcp_probe",
      "provenance": "expected_obu_invocation",
      "probeCommandSource": "expected_obu_invocation",
      "mcpConfigured": true,
      "mcpStarts": true,
      "sdkBootstrap": "available",
      "backendCount": 1,
      "backends": [
        {
          "type": "webextension",
          "browser": "chrome",
          "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
          "extensionIdentity": {
            "source": "descriptor_metadata",
            "verified": true
          },
          "metadata": {
            "browserKind": "chrome",
            "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj"
          }
        }
      ]
    },
    "agentRuntime": {
      "source": "not_checked",
      "provenance": "not_applicable",
      "probeCommandSource": "not_applicable",
      "mcpConfigured": true,
      "mcpStarts": null,
      "sdkBootstrap": "not_checked",
      "backendCount": null,
      "backends": []
    }
  },
  "nextAction": null,
  "checks": [
    {
      "id": "cli-version",
      "layer": "cli_install",
      "status": "pass",
      "message": "obu version is parseable",
      "target": {},
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "cli_version"
      }
    },
    {
      "id": "native-host-manifest",
      "layer": "native_host",
      "status": "pass",
      "message": "native host allows chrome-extension://fblnfcjnjklpgnmfnngcihbcgojnpadj/",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "native_host_manifest"
      }
    },
    {
      "id": "browser-profile",
      "layer": "browser_profile",
      "status": "pass",
      "message": "resolved one matching enabled Chrome profile",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "profile_discovery"
      }
    },
    {
      "id": "browser-extension-installed",
      "layer": "browser_extension",
      "status": "pass",
      "message": "extension is installed and enabled in the resolved profile",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "profile_preferences"
      }
    },
    {
      "id": "extension-runtime",
      "layer": "extension_runtime",
      "status": "pass",
      "message": "extension runtime inferred active from descriptor probe",
      "details": {
        "source": "runtime_descriptor_probe"
      },
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "browser_extension",
        "provenance": "runtime_descriptor_probe",
        "source": "runtime_descriptor_probe"
      }
    },
    {
      "id": "runtime-descriptor-probe",
      "layer": "runtime_descriptor",
      "status": "pass",
      "message": "chrome.json responded to getInfo",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "browser_extension",
        "provenance": "runtime_descriptor_probe",
        "source": "runtime_descriptor_probe"
      }
    },
    {
      "id": "mcp-runtime-backend",
      "layer": "mcp_runtime",
      "status": "pass",
      "message": "direct MCP probe found 1 usable backend",
      "target": {
        "agent": "codex-cli",
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "direct_mcp_probe"
      }
    },
    {
      "id": "agent-mcp-server",
      "layer": "agent_mcp",
      "status": "pass",
      "message": "codex-cli configures open-browser-use",
      "target": {
        "agent": "codex-cli"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "agent_config_read"
      }
    },
    {
      "id": "agent-primary-instruction",
      "layer": "agent_instruction",
      "status": "pass",
      "message": "primary browser instruction found",
      "target": {
        "agent": "codex-cli"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "agent_instruction_file"
      }
    },
    {
      "id": "agent-runtime-status",
      "layer": "agent_runtime",
      "status": "not_checked",
      "reason": "verification_target_cli",
      "message": "agent-runtime status was not requested",
      "target": {
        "agent": "codex-cli"
      },
      "evidence": {
        "scope": "agent_runtime",
        "provenance": "not_applicable",
        "source": "verification_target_cli"
      }
    }
  ]
}
```

Non-ready result:

```json
{
  "schemaVersion": 1,
  "command": "verify",
  "verificationTarget": "cli",
  "result": "needs_browser_popup",
  "readiness": {
    "cli": "blocked",
    "agentRuntime": "not_checked"
  },
  "agent": {
    "id": "codex-cli",
    "mcpConfig": {
      "status": "pass"
    },
    "instructions": {
      "status": "pass"
    },
    "runtimeStatus": {
      "status": "not_checked",
      "provenance": "not_applicable",
      "reason": "verification_target_cli"
    }
  },
  "browser": {
    "kind": "chrome",
    "channel": "store",
    "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
    "extensionIdSource": "explicit-argument",
    "profile": {
      "path": "/Users/alex/Library/Application Support/Google/Chrome/Default",
      "suggestedPath": null,
      "source": "default_discovery",
      "runtimeBinding": "not_available",
      "candidates": [
        {
          "path": "/Users/alex/Library/Application Support/Google/Chrome/Default",
          "profileExists": "pass",
          "extensionInstalled": "pass",
          "extensionEnabled": "pass"
        }
      ]
    },
    "extensionInstalled": "pass",
    "extensionEnabled": "pass",
    "nativeHost": "pass",
    "runtimeDescriptor": "missing",
    "reasons": {
      "runtimeDescriptor": "no active WebExtension descriptor found"
    },
    "resumeRequired": true
  },
  "mcpRuntime": {
    "cli": {
      "source": "not_checked",
      "provenance": "not_applicable",
      "probeCommandSource": "not_applicable",
      "mcpConfigured": true,
      "mcpStarts": null,
      "sdkBootstrap": "not_checked",
      "backendCount": null,
      "backends": [],
      "reason": "runtime_descriptor_not_active"
    },
    "agentRuntime": {
      "source": "not_checked",
      "provenance": "not_applicable",
      "probeCommandSource": "not_applicable",
      "mcpConfigured": true,
      "mcpStarts": null,
      "sdkBootstrap": "not_checked",
      "backendCount": null,
      "backends": []
    }
  },
  "nextAction": {
    "kind": "open_popup",
    "message": "Open the open-browser-use extension popup. Click Resume if enabled; otherwise wait for Connected and rerun verify.",
    "url": "chrome-extension://fblnfcjnjklpgnmfnngcihbcgojnpadj/popup.html",
    "browser": "chrome",
    "profile": {
      "path": "/Users/alex/Library/Application Support/Google/Chrome/Default"
    },
    "rerun": "obu verify --agent=codex-cli --browser=chrome --channel=store --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj"
  },
  "checks": [
    {
      "id": "cli-version",
      "layer": "cli_install",
      "status": "pass",
      "message": "obu version is parseable",
      "target": {},
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "cli_version"
      }
    },
    {
      "id": "native-host-manifest",
      "layer": "native_host",
      "status": "pass",
      "message": "native host allows chrome-extension://fblnfcjnjklpgnmfnngcihbcgojnpadj/",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "native_host_manifest"
      }
    },
    {
      "id": "browser-profile",
      "layer": "browser_profile",
      "status": "pass",
      "message": "resolved one matching enabled Chrome profile",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "profile_discovery"
      }
    },
    {
      "id": "browser-extension-installed",
      "layer": "browser_extension",
      "status": "pass",
      "message": "extension is installed and enabled in the resolved profile",
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "profile_preferences"
      }
    },
    {
      "id": "extension-runtime",
      "layer": "extension_runtime",
      "status": "fail",
      "blocks": [
        "cli"
      ],
      "reason": "runtime_descriptor_not_active",
      "message": "extension runtime is not active from CLI-observable evidence",
      "details": {
        "source": "runtime_descriptor_probe"
      },
      "actionCandidate": {
        "kind": "open_popup",
        "priority": 1,
        "result": "needs_browser_popup"
      },
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "browser_extension",
        "provenance": "runtime_descriptor_probe",
        "source": "runtime_descriptor_probe"
      }
    },
    {
      "id": "runtime-descriptor-probe",
      "layer": "runtime_descriptor",
      "status": "fail",
      "blocks": [
        "cli"
      ],
      "reason": "descriptor_missing",
      "message": "no active WebExtension descriptor found",
      "details": {
        "resumeRequired": true
      },
      "actionCandidate": {
        "kind": "open_popup",
        "priority": 1,
        "result": "needs_browser_popup"
      },
      "target": {
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "browser_extension",
        "provenance": "runtime_descriptor_probe",
        "source": "runtime_descriptor_probe"
      }
    },
    {
      "id": "mcp-runtime-backend",
      "layer": "mcp_runtime",
      "status": "not_checked",
      "reason": "runtime_descriptor_not_active",
      "message": "direct MCP probe was not run",
      "target": {
        "agent": "codex-cli",
        "browser": "chrome",
        "channel": "store",
        "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
        "profile": "/Users/alex/Library/Application Support/Google/Chrome/Default"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "direct_mcp_probe"
      }
    },
    {
      "id": "agent-mcp-server",
      "layer": "agent_mcp",
      "status": "pass",
      "message": "codex-cli configures open-browser-use",
      "target": {
        "agent": "codex-cli"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "agent_config_read"
      }
    },
    {
      "id": "agent-primary-instruction",
      "layer": "agent_instruction",
      "status": "pass",
      "message": "primary browser instruction found",
      "target": {
        "agent": "codex-cli"
      },
      "evidence": {
        "scope": "cli",
        "provenance": "expected_obu_invocation",
        "source": "agent_instruction_file"
      }
    },
    {
      "id": "agent-runtime-status",
      "layer": "agent_runtime",
      "status": "not_checked",
      "reason": "verification_target_cli",
      "message": "agent-runtime status was not requested",
      "target": {
        "agent": "codex-cli"
      },
      "evidence": {
        "scope": "agent_runtime",
        "provenance": "not_applicable",
        "source": "verification_target_cli"
      }
    }
  ]
}
```

## Human Output Contract

Ready:

```text
open-browser-use is CLI-ready.
Agent: codex-cli
Browser: chrome Store extension fblnfcjnjklpgnmfnngcihbcgojnpadj
Backend: webextension descriptor chrome.json responded to getInfo
MCP runtime: direct probe found 1 usable backend
Agent runtime: not checked
```

Browser popup required:

```text
Browser popup required.
Local setup is correct, but no active WebExtension descriptor exists yet.
Open the open-browser-use extension popup. Click Resume if enabled.
If it already shows Connected, wait briefly and rerun:
  obu verify --agent=codex-cli --browser=chrome --channel=store --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

Repair required:

```text
Repair required.
Chrome native host manifest does not allow extension fblnfcjnjklpgnmfnngcihbcgojnpadj.
Run:
  obu verify --repair --agent=codex-cli --browser=chrome --channel=store --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj
```

Manual action required:

```text
Agent configuration conflict.
Codex already has an open-browser-use MCP server with different settings.
Review /Users/alex/.codex/config.toml and keep the intended command.
Expected:
  /Users/alex/.obu/bin/obu mcp stdio
```

## Popup Contract

The popup must distinguish host connection from descriptor readiness.

Required state fields:

- `Native host: connected | disconnected`
- `Host version: <version> | unknown`
- `Descriptor: active | missing | stale | invalid`
- `Resume required: yes | no`
- `Last descriptor refresh: <timestamp> | never`

The Resume button state must match the state model:

- Enabled when the extension knows a resume action can refresh or reconnect the
  descriptor.
- Disabled when the extension is already connected or no resume action is
  meaningful.

If Resume is disabled while the host is connected, the UI must not imply failure.
The correct guidance is to rerun `obu verify` and confirm `resumeRequired:
false`.

## Browser Popup Boundary

Opening the popup is sometimes required because the selected Chromium-family
browser controls MV3 extension runtime activation.

`obu verify --repair` can fix:

- native-host manifests;
- allowed extension origins;
- host binary paths;
- runtime directory permissions;
- stale or invalid descriptor files.

It cannot force the browser to:

- wake the MV3 service worker immediately;
- reconnect the extension to native messaging from outside the browser;
- write a fresh WebExtension descriptor without extension runtime activity.

When all file/config state is correct but no descriptor is active, the product
must return `needs_browser_popup`, not `ready` and not `needs_repair`.

## Extension Handoff Contract

The extension handoff prompt must include:

- extension channel;
- exact extension id;
- reminder not to infer a different Store id;
- instruction to ensure `~/.obu/bin/obu` exists before writing MCP config;
- canonical agent ids for known agents;
- instruction to verify with `obu verify`;
- popup guidance that says "click Resume if enabled" rather than assuming Resume
  is always clickable.

Shipped popup handoff text must point users at `obu verify` as the canonical
readiness command. It may reference `obu doctor browser` only as a lower-level
diagnostic after verify has identified a browser-specific boundary.

The Store extension id is security-sensitive native messaging state. Every
doctor, setup, repair, verify, and generated command must preserve the exact
handoff id unless OBU can prove the same id is already configured.

## Setup Contract

`obu setup` remains the mutating setup command. It must not be the canonical
readiness answer.

Setup requirements:

- Accept human agent aliases and normalize to canonical ids.
- Write each first-class agent config to the same surface that doctor verifies.
- Do not overwrite divergent MCP server settings.
- Return manual action for unreadable or divergent config.
- Preserve exact Store extension ids in all suggested verify and repair
  commands.
- Write primary-browser instructions only when explicitly requested.
- Include the final verification command in next actions.

Final setup output should tell users to run `obu verify`, not ask them to
interpret setup completion as browser readiness.

## Doctor Contract

`obu doctor browser` and `obu agent doctor` remain lower-level diagnostic
commands.

Doctor requirements:

- Browser doctor must expose `resume_required` in details.
- Browser doctor must preserve exact channel and extension id in repair hints.
- Browser doctor must distinguish warnings from live backend readiness.
- Agent doctor must fail divergent config instead of falling back to another
  probe that masks the conflict.
- Agent doctor must report unsupported instruction checks as `warn`, not fail.
- Agent doctor must use timeouts that avoid false failures for normal client
  startup latency.

Doctor commands can produce many checks. `obu verify` is responsible for turning
those checks into one product result.

## MCP Runtime Contract

MCP runtime JSON is split by trust boundary. `mcpRuntime.cli` records direct
OBU-owned MCP probing for CLI readiness. `mcpRuntime.agentRuntime` records the
selected running agent process's MCP status when a trusted hook is available, or
an explicit diagnostic/not-checked state when it is not.

Both summaries use the same normalized fields:

- `source`: `agent_runtime | agent_runtime_status_file | direct_mcp_probe |
  not_checked`.
- `provenance`: `agent_runtime_hook | expected_obu_invocation |
  user_supplied_status_file | not_applicable`.
- `mcpConfigured`: whether the target agent has an equivalent server config.
- `probeCommandSource`: `expected_obu_invocation | agent_runtime_hook |
  not_applicable`; direct probes must use `expected_obu_invocation`.
- `mcpStarts`: `true | false | null`; whether the MCP process can start when
  checked directly.
- `sdkBootstrap`: `available | missing | untrusted | not_checked`.
- `backendCount`: `number | null`; number of usable browser backends.
- `backends`: normalized backend summaries when available. WebExtension backend
  summaries must include `type`, `browser`, `extensionId`, and
  `extensionIdentity`. A WebExtension backend without verified extension identity
  cannot contribute to `backendCount` for extension-scoped readiness.

`mcpRuntime.cli.source` may be only `direct_mcp_probe` or `not_checked`.
`mcpRuntime.agentRuntime.source` may be only `agent_runtime`,
`agent_runtime_status_file`, or `not_checked`.

For `verificationTarget: "cli"`, `mcpRuntime.agentRuntime.source` is normally
`not_checked`; the agent-runtime layer still appears in `checks[]` as a
non-blocking `not_checked` check. For `verificationTarget: "agent_runtime"`, a
ready result requires both `mcpRuntime.cli` and `mcpRuntime.agentRuntime` to have
`sdkBootstrap: "available"` and `backendCount > 0`, each from its own trust
boundary.

`mcpRuntime.agentRuntime.source: "agent_runtime"` means the status came from the
selected agent process after it reloaded MCP tools. Only this source can make
`readiness.agentRuntime` become `ready`; `probeCommandSource` must be
`agent_runtime_hook` and `provenance` must be `agent_runtime_hook`. The
corresponding `agent.runtimeStatus` object must include the trusted hook id,
transport, freshness, and target-binding result. Since OBU did not directly
launch the MCP process in this mode, `mcpStarts` may be `null`; `sdkBootstrap`,
`backendCount`, and `backends` are normalized from the trusted hook payload.

`mcpRuntime.cli.source: "direct_mcp_probe"` means OBU launched or probed the MCP
server itself. It can prove CLI-level backend readiness, but it must not be
treated as proof that the selected agent process has reloaded MCP tools. The
command must be the expected OBU MCP invocation for the current layout, not a
command copied from a divergent agent config. `provenance` must be
`expected_obu_invocation`.

`mcpRuntime.agentRuntime.source: "agent_runtime_status_file"` means OBU read a
user-supplied status file that may contain challenge-bound agent-runtime
evidence, but the transport itself is not trusted agent-runtime provenance. It
must use `provenance: "user_supplied_status_file"` and
`probeCommandSource: "not_applicable"`, and it must not make
`readiness.agentRuntime` ready. Because this source is diagnostic-only, readiness
summary fields must not be populated from the file payload: `mcpStarts` must be
`null`, `sdkBootstrap` must be `not_checked`, `backendCount` must be `null`, and
`backends` must be an empty array. The raw file payload may appear only under
`details.raw` or `mcpRuntime.agentRuntime.diagnostic.raw`; parsed diagnostic
summaries, if any, must live under `mcpRuntime.agentRuntime.diagnostic` and must
not affect `readiness`.

When `mcpRuntime.cli.source: "direct_mcp_probe"` and the MCP process cannot start,
`mcpStarts` must be `false`, `sdkBootstrap` must be `not_checked`,
`backendCount` must be `null`, `backends` must be an empty array, and the
blocking check must include launch error details. If the MCP process starts but
`browser_status` cannot be read, `mcpStarts` must be `true`, `sdkBootstrap` must
be `not_checked`, `backendCount` must be `null`, and `backends` must be an empty
array.

`source: "not_checked"` means that summary's MCP runtime status was not probed.
In that case `provenance` and `probeCommandSource` must be `not_applicable`,
`mcpStarts` must be `null`, `sdkBootstrap` must be `not_checked`, `backendCount`
must be `null`, and `backends` must be an empty array.

`backendCount: 0` means not ready for browser automation even if
`sdkBootstrap: "available"`.

Normalized backend summary shape:

```json
{
  "type": "webextension",
  "browser": "chrome",
  "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
  "extensionIdentity": {
    "source": "descriptor_metadata",
    "verified": true
  },
  "socketPath": "/path/to/socket",
  "metadata": {
    "browserKind": "chrome",
    "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj"
  }
}
```

`socketPath` may be omitted from human output, but if it is present in JSON it
must be the canonical socket path used for the verified backend. Raw MCP backend
payloads use fields such as `type`, `name`, `socketPath`, and
`metadata.browser_kind`; verify may include those raw payloads only under
`details.raw`.

For setup probes, agents should end turns with `turnEnded()` when the goal is to
keep the browser connection alive. `finishTurn({ keep: [] })` intentionally
releases state and can remove runtime descriptors.

## Acceptance Criteria

The product is complete only when all of the following are true:

- One command, `obu verify`, returns the canonical readiness result.
- JSON output has the stable schema described above, including
  `verificationTarget`, object-shaped `agent.runtimeStatus`, required
  `mcpRuntime.cli.backends`, `mcpRuntime.agentRuntime.backends`, and non-empty
  `checks[]` evidence.
- Human output gives one next action and no ambiguous action chain.
- Result selection is dependency-gated: CLI-blocking checks determine the result
  before any agent-runtime blocker can be selected.
- `ready` is impossible when a required runtime summary has `backendCount` zero
  or `sdkBootstrap` not `available`: CLI readiness requires
  `mcpRuntime.cli`, and agent-runtime readiness requires both `mcpRuntime.cli`
  and `mcpRuntime.agentRuntime`.
- `verificationTarget: "agent_runtime"` cannot return `ready` unless
  `readiness.agentRuntime` is `ready`, and agent-runtime evidence has fresh
  challenge binding, target binding, `provenance: "agent_runtime_hook"`, trusted
  hook transport, and verified WebExtension extension identity matching
  `browser.extensionId`.
- Agent-runtime readiness has a first-class `agent_runtime` check layer and a
  trusted hook contract; user-supplied status files are never the trust boundary.
- Trusted hook identity and trust are derived from OBU's hook registry and
  trusted transport, not accepted from payload fields.
- User-supplied agent-runtime status files without trusted hook provenance remain
  diagnostic evidence only and cannot make agent-runtime readiness `ready`. Their
  payloads do not populate readiness summary fields.
- WebExtension `backendCount` excludes metadata-less, `"unknown"`, wrong-browser,
  or wrong-extension backends; Store-channel readiness always requires exact
  extension id proof and JSON reports `browser.extensionIdSource`.
- Normalized backend summaries use the documented `type`, `browser`,
  `extensionId`, and `extensionIdentity` shape; raw backend payloads stay under
  `details.raw`.
- Browser profile discovery is deterministic and reports candidate profile state.
- Multi-profile default discovery reports `suggestedPath` but does not treat it
  as `browser.profile.path` unless runtime proof is `profile_verified`.
- Explicit-profile readiness may be browser/extension-scoped only when JSON and
  human output warn with `reason: "profile_runtime_not_bound"`; multi-profile
  default readiness still requires `profile_verified` or `select_profile`.
- Missing profile roots or nonexistent explicit profiles produce
  `nextAction.kind: "select_profile"`, not `install_extension`.
- Unreadable profile roots or profile files produce unreadable/profile-inspection
  reasons instead of being collapsed into `missing`.
- Component summary fields using any value other than `pass` include per-field
  reasons.
- Same-result-class failures choose `nextAction` from blocking checks'
  `actionCandidate` values by the deterministic priority table in this document.
- Every allowed `nextAction.kind` is covered by the action derivation source
  table.
- Every check includes explicit `target` and `evidence` objects.
- Agent-runtime hook unavailability has a defined `needs_manual_action` state
  with `nextAction.kind: "unsupported"`, and registered-hook challenge issuance
  has a defined pending state with
  `nextAction.kind: "collect_agent_runtime_status"`.
- Direct MCP probes never execute divergent or unreadable agent-config commands.
- `needs_browser_popup` is returned when local setup is correct but descriptor
  activation is missing.
- `open_popup` actions preserve browser/profile context and do not rely on a
  generic OS `open` command when that could target the wrong profile.
- `needs_repair` includes a repair command with exact browser/channel/extension
  id.
- `needs_manual_action` is returned for divergent agent config.
- Setup and doctor use the same source of truth for Codex and Cursor.
- Agent aliases are accepted but canonical ids are emitted.
- Popup status distinguishes native-host connection from descriptor readiness.
- Extension handoff text preserves exact Store extension id and tells agents to
  verify readiness through OBU.
- Popup handoff text and tests replace doctor retry guidance with verify retry
  guidance while preserving doctor as a lower-level diagnostic fallback.
- Clean-home smoke tests cover Codex, Cursor, Store extension id preservation,
  popup-required descriptor state, and divergent config conflicts.
- Smoke or unit tests cover direct MCP runtime zero-backend results, SDK
  bootstrap missing/untrusted results, disabled extensions, explicit profile
  mismatch, deterministic multi-profile selection, wrong-browser or
  wrong-extension descriptors, explicit `--profile` preservation in rerun/repair
  commands, read-only verification performing no writes, stale or unbound
  agent-runtime status JSON, challenge issuance mode, direct probe refusal for
  divergent agent config, and `--repair` refusing divergent agent config.

## Product Principle

No user or agent should need to infer readiness by stitching together partial
success messages. OBU owns the state closure and returns one truthful next
action.
