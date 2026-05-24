// All finalize-tabs protocol types and pure planners now live in the
// browser-control-core package. Re-export the full surface so existing
// importers (finalize_tabs_controller) keep resolving every symbol.
export * from "@open-browser-use/browser-control-core";
