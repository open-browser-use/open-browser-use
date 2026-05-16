# open-browser-use Wire Protocol

This is the P1 + P2 reference for traffic between `@open-browser-use/sdk`, `obu-node-repl`,
and `obu-host`.

## Framing

The SDK-to-host socket uses:

- 4-byte little-endian length prefix.
- UTF-8 JSON-RPC 2.0 body.
- `MAX_FRAME_LEN = 16 MiB`, defined in `crates/obu-wire/src/frame.rs`.

## Direction

- SDK to `obu-host`: JSON-RPC requests.
- `obu-host` to SDK: JSON-RPC responses.

P2 does not use push notifications for downloads or file choosers. Those flows
use request/response handles such as `playwright_wait_for_download` and
`playwright_download_path`.

## Handshake

There is no version handshake on the P2 SDK-to-host socket. There is no
`hello`, `hello_ack`, or `version_mismatch` frame in this channel.

By convention, the SDK sends `getInfo` first after connecting so it can read the
backend `{ type, name, metadata, capabilities }`. The dispatcher treats it as a
normal method, not as a required handshake.

## Capability Token

If `OBU_CAPABILITY_TOKEN` is set for `obu-host`, the first JSON-RPC frame must
be:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "auth",
  "params": { "capability_token": "..." }
}
```

The Rust native-pipe broker in `obu-node-repl` prepends this frame when it opens
a socket. Kernel JavaScript and `@open-browser-use/sdk` never read or receive the token. A
missing or wrong token returns `-1100` and the host closes the peer.

## Timeouts

Each SDK request includes `client_timeout_ms` in `params`. The SDK also arms a
defensive local timer for `client_timeout_ms + 5000ms` by default. Browser-side
retry loops use `client_timeout_ms` as their deadline and report timeout errors
as `-1000`.

## Side Effects

A successful response may include `side_effects: string[]`. The SDK transport
passes each side effect to the kernel-locked `display()` global before resolving
the caller's promise.

## Method Index

Method constants live in both:

- `crates/obu-host/src/methods.rs`
- `packages/sdk/src/wire/methods.ts`

`crates/obu-host/tests/method_name_sync.rs` keeps the two lists synchronized.

## Error Codes

| Range | Meaning |
| --- | --- |
| `-32xxx` | JSON-RPC 2.0 standard errors |
| `-1000..-1099` | server, timeout, IO, protocol |
| `-1100..-1199` | guard and auth failures |
| `-1200..-1299` | backend failures |
| `-2000+` | user-program errors |

See `crates/obu-wire/src/error.rs` for constants.
