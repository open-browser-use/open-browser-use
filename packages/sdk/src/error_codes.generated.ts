// Generated from wire/error-codes.json by scripts/generate-error-codes.mjs.
// Do not edit by hand.

/** Defensive or backend timeout. */
export const ERR_TIMEOUT = -1000;
/** Requested object was not found. */
export const ERR_NOT_FOUND = -1001;
/** Operation is disallowed at the server level. */
export const ERR_DISALLOWED = -1002;
/** Feature is not implemented. */
export const ERR_NOT_IMPLEMENTED = -1003;
/** Protocol violation. */
export const ERR_PROTOCOL = -1004;
/** No usable browser backend is available. */
export const ERR_NO_BACKEND = -1005;
/** Peer has too many concurrent in-flight requests. */
export const ERR_OVERLOADED = -1006;
/** Request conflicts with an existing durable task/session/turn owner. */
export const ERR_CONFLICT = -1007;
/** Generic I/O failure. */
export const ERR_IO = -1099;
/**
 * Peer/auth gate rejected the connection.
 *
 * D9 and the Phase 9 failure-mode test pin wrong capability-token auth to
 * `-1100`, so the dispatcher uses this code for first-frame auth rejection.
 */
export const ERR_PEER_AUTH = -1100;
/** Capability-token specific guard code for later structured policy surfaces. */
export const ERR_CAPABILITY_TOKEN = -1101;
/** Command-level guard rejection. */
export const ERR_CMD_DISALLOWED = -1102;
/** Page or target has closed. */
export const ERR_PAGE_CLOSED = -1200;
/** CDP command failed. */
export const ERR_CDP_FAILURE = -1201;
/** Tab has not been attached. */
export const ERR_TAB_NOT_ATTACHED = -1202;
/** Native browser dialog needs an explicit user/agent decision. */
export const ERR_DIALOG_REQUIRES_DECISION = -1203;
/**
 * Navigation failed at the network layer (connection reset, DNS, TLS, refused).
 *
 * Carries structured data { netError, url, retryable } so agents can tell a
 * retryable site/network failure from a protocol error.
 */
export const ERR_NAVIGATION_FAILED = -1204;
