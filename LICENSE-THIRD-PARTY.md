# Third-Party Notices

## Playwright InjectedScript

`crates/obu-host/vendored/playwright-injected.js` is a compiled Playwright
InjectedScript bundle used by the CDP backend for page-side selector and
actionability semantics.

- Upstream project: Microsoft Playwright
- License: Apache License 2.0
- Bundled file:
  `crates/obu-host/vendored/playwright-injected.js`
- Pinned SHA-256:
  `crates/obu-host/vendored/PINNED_HASH`

The upstream Apache-2.0 license text is available at:
https://www.apache.org/licenses/LICENSE-2.0

## Node.js Runtime

P4 release payloads include a full upstream Node.js 22.x runtime at or above
22.22.0. The payload assembly script records the exact Node version in
`metadata.json`; release builds must use `scripts/assemble-payload.mjs
--node-root` so the full Node distribution, including its upstream license
files, is carried in the payload.

- Upstream project: Node.js
- License: MIT License, with third-party notices included in the upstream Node
  distribution
- Source: https://nodejs.org/

## jsonc-parser

The CLI packages `jsonc-parser` for JSON/JSONC agent adapter config edits.

- Upstream project: Microsoft jsonc-parser
- License: MIT License
- Packaged path: `node_modules/jsonc-parser`
- Source: https://github.com/microsoft/node-jsonc-parser

## Meriyah

`crates/obu-node-repl/embedded/meriyah.umd.min.js` is bundled into the
JavaScript kernel runtime for source parsing and instrumentation.

- Upstream project: Meriyah
- License: ISC License
- Bundled file: `crates/obu-node-repl/embedded/meriyah.umd.min.js`
- Source: https://www.npmjs.com/package/meriyah
