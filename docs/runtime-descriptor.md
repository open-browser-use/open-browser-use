# Runtime Descriptor Schema

Runtime descriptors are owner-only JSON files written by `obu-host` native
messaging mode, discovered by `obu-node-repl`, and probed by the CLI browser
doctor. They advertise a live WebExtension-backed SDK socket without exposing
that socket directly to untrusted JavaScript.

The current schema is version 1. A reference fixture lives at
`tests/fixtures/runtime-descriptor/v1-webextension.json`.

## Location and Ownership

Descriptors live under:

```text
${OBU_RUNTIME_DIR}/webextension/*.json
```

If `OBU_RUNTIME_DIR` is not set, the platform runtime directory resolver chooses
the local owner-only open-browser-use runtime directory. The runtime root,
`webextension` descriptor directory, descriptor files, and descriptor socket are
validated as owner-only. On Unix, descriptor files are written with `0600` and
directories with `0700`.

## Version 1 Fields

| Field | Type | Owner | Sensitivity | Notes |
| --- | --- | --- | --- | --- |
| `schema_version` | number | host | public | Must be `1`. |
| `type` | string | host | public | Must be `webextension`. |
| `name` | string | host | public | Backend name exposed through `getInfo.name`, usually the browser kind such as `chrome`. |
| `socketPath` | string | host | local-sensitive | Owner-only Unix socket path used by the parent native-pipe broker. |
| `sdk_auth_token` | string | host | secret | Capability token for the SDK socket. Readers must not expose it to SDK user code, browser status output, or diagnostics. |
| `pid` | number | host | public | Host process id used for stale descriptor detection. |
| `startedAt` | string | host | public | Millisecond Unix timestamp string for descriptor lifecycle diagnostics. |
| `metadata` | object | host plus extension hello | redacted | Browser/extension/profile metadata. Raw profile paths and display names must not be written. |

## Reader Contract

`obu-node-repl` accepts only schema version 1 WebExtension descriptors with a
string `socketPath` and string `sdk_auth_token`. It validates descriptor file
ownership, socket ownership, process liveness, and a short `auth` + `getInfo`
probe before exposing a backend. It stores the token only in the parent
native-pipe broker token map keyed by canonical socket path.

The CLI browser doctor performs the same schema checks before probing the socket.
It reports descriptor lifecycle diagnostics from `getInfo.metadata.diagnostics`
and keeps stale descriptor diagnostics intact for repair decisions.

## Token Boundary

`sdk_auth_token` exists because the descriptor is read by trusted parent-side
runtime code. It must not appear in:

- `globalThis.obuRepl.discoverBackends()`
- `globalThis.obuRepl.discoverBackendDiagnostics()`
- MCP `browser_status`
- CLI human or JSON diagnostics
- SDK user-facing errors

The SDK receives only the socket path; the parent native-pipe bridge injects the
auth frame when it opens that socket.
