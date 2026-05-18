# obu-node-repl

Per-session MCP server for open-browser-use. It runs JavaScript in a managed Node child
and exposes four tools over MCP stdio:

- `js`
- `browser_status`
- `js_reset`
- `js_add_module_dir`

## Build

```bash
cargo build -p obu-node-repl
cargo test -p obu-node-repl
```

Node must be available on `PATH` or via `OBU_NODE_BINARY`, and must be
`v22.22.0` or newer.

## Run

```bash
cargo run -p obu-node-repl -- mcp stdio
```

Example MCP client config:

```json
{
  "mcpServers": {
    "obu-node-repl": {
      "command": "/path/to/obu-node-repl",
      "args": ["mcp", "stdio"]
    }
  }
}
```

## Environment

- `OBU_NODE_BINARY`: Node executable override.
- `OBU_SESSION_ID`: optional session id.
- `OBU_NODE_REPL_MODULE_DIRS`: path-delimited module search roots.
- `OBU_TRUSTED_CODE_PATHS`: path-delimited trusted source roots.
- `OBU_TRUSTED_MODULE_SHA256S`: colon-delimited trusted SHA-256 source hashes.
- `OBU_TRUST_ALL_CODE=1`: trust every imported module.
- `OBU_BACKENDS`: semicolon-delimited backend inventory, shaped as
  `type:name:absolute-socket-path`.
- `OBU_CAPABILITY_TOKEN`: parent-only token that the Rust native-pipe broker
  prepends to fresh `obu-host` socket connections.
- `OBU_NATIVE_PIPE_CONNECT_TIMEOUT_MS`: native-pipe connect timeout.
- `OBU_SANDBOX_ALLOWED_UNIX_SOCKETS`: optional path-delimited allow-list for
  socket paths the Rust broker may open.

## Browser SDK Bootstrap

When `@open-browser-use/sdk` is installed under an entry in `OBU_NODE_REPL_MODULE_DIRS` and
its `dist/version.json` hash is trusted, the kernel imports it during bootstrap
and installs locked `agent` and `help` globals. The SDK reads backend inventory
from `globalThis.obuRepl.discoverBackends()` and connects lazily when user code
calls `agent.browsers.get(kind)`.

Example with a running `obu-host`:

```bash
OBU_BACKENDS='cdp:chromium:/tmp/obu-host.sock' \
OBU_CAPABILITY_TOKEN='dev-token' \
OBU_NODE_REPL_MODULE_DIRS='/path/to/workspace' \
OBU_TRUSTED_MODULE_SHA256S='<sha256-of-packages/sdk/dist/index.mjs>' \
cargo run -p obu-node-repl -- mcp stdio
```
