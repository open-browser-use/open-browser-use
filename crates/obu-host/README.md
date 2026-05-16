# obu-host

Per-session broker daemon for open-browser-use. It owns a local Unix-domain socket and
routes length-prefixed JSON-RPC between the agent SDK running inside
`obu-node-repl` and a browser backend.

## What it Runs

The host currently ships two backend implementations:

| Backend | Status |
| --- | --- |
| `CdpBackend` | Functional raw-CDP backend for Chromium-compatible browsers launched with remote debugging enabled. |
| `WebExtensionBackend` | Chromium MV3 extension backend used by `obu-host --native-messaging`. |

For `agent.browsers.get("cdp")`, the SDK selects the CDP backend directly. For
Chromium-family kinds such as `chrome`, `edge`, `brave`, `arc`, or `chromium`,
the SDK prefers a live WebExtension descriptor and falls back to CDP when one is
available.

## Build and Run

```bash
cargo build -p obu-host
./target/debug/obu-host \
  --socket /tmp/obu-host.sock \
  --cdp-url http://127.0.0.1:9222 \
  --peer-auth auto
```

The matching `obu-node-repl` process discovers this backend through
`OBU_BACKENDS`, for example:

```bash
OBU_BACKENDS='cdp:chromium:/tmp/obu-host.sock' \
OBU_CAPABILITY_TOKEN='dev-token' \
obu-node-repl mcp stdio
```

If `OBU_CAPABILITY_TOKEN` is set for `obu-host`, the Rust native-pipe broker in
`obu-node-repl` must be started with the same token. Kernel JavaScript and the
SDK never receive that token.

## Native Messaging Mode

The Chromium extension starts the host through Chrome Native Messaging:

```bash
obu-host --native-messaging
```

In this mode Chrome owns stdin/stdout. The first frame must be the extension
`hello`; the host responds with `hello_ack`, binds an owner-only SDK Unix
socket, writes a runtime WebExtension descriptor, and serves normal P2 JSON-RPC
on that socket. The descriptor contains a per-socket `sdk_auth_token`; only the
Rust node-repl broker reads it, and it is stripped before
`globalThis.obuRepl.discoverBackends()` reaches JavaScript.

Runtime descriptors are written under the resolved runtime directory:

```text
<runtime-dir>/webextension/
```

Resolution order is `OBU_RUNTIME_DIR`, then the platform default: Linux
`$XDG_RUNTIME_DIR/obu` when available, otherwise `/tmp/obu-<uid>`; macOS uses
`/tmp/obu-<uid>`. P4 production wrappers must set the persisted
`OBU_RUNTIME_DIR` explicitly before launching native-messaging mode, because a
browser-launched host process and an agent shell must not rely on accidentally
matching temporary-directory environments.

The extension popup Stop action sends `stopBrowserControl`. The host marks the
backend inactive, removes the descriptor, stops accepting new SDK peers on that
socket, and existing SDK peers receive the stable backend-inactive error on
browser-control methods.

For a development install, build the host and run:

```bash
pnpm -C packages/extension build
pnpm -C packages/extension dev:manifest -- --browser chrome
```

Then load `packages/extension/dist` as an unpacked extension.

This development manifest path is not the P4 production install path. Production
`obu install-host` must write stable wrappers under the user open-browser-use config
directory, set `OBU_BROWSER_KIND` and `OBU_RUNTIME_DIR`, validate the runtime
directory, and then exec the packaged `obu-host --native-messaging`.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBU_HOST_SOCKET_PATH` | auto from session id | Socket path for the broker listener. |
| `OBU_SESSION_ID` | UUIDv4 | Session id used when deriving the default socket path. |
| `OBU_CDP_URL` | unset | HTTP or WebSocket CDP endpoint for `CdpBackend`. |
| `OBU_CAPABILITY_TOKEN` | unset | First-frame capability-token gate. Held by Rust processes only. |
| `OBU_PEER_AUTH` | `auto` | Peer-auth mode: `auto`, `strict`, or `off`. |
| `OBU_LOG` | `info` | Tracing filter. |
| `OBU_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/obu` on Linux, otherwise `/tmp/obu-<uid>` | Runtime descriptor root for native-messaging WebExtension backends. Must be an owner-only real directory. |

## Protocol Notes

- Framing is a 4-byte little-endian length prefix followed by a UTF-8 JSON-RPC
  2.0 body.
- There is no version handshake on the SDK-to-host socket in P2.
- If a capability token is configured, the first frame must be the
  broker-prepended `auth` request.
- Normal SDK traffic conventionally starts with `getInfo`, but the dispatcher
  does not require `getInfo` as a special handshake.

## CDP Backend

`CdpBackend` uses raw Chrome DevTools Protocol for target creation, navigation,
screenshots, content export, coordinate input, and the Playwright-shaped locator
facade. The locator facade evaluates a vendored Playwright InjectedScript bundle
inside the target page.

The vendored Playwright code is Apache-2.0. See
[LICENSE-THIRD-PARTY.md](../../LICENSE-THIRD-PARTY.md) and
[vendored/README.md](vendored/README.md).
