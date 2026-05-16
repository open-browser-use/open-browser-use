#!/usr/bin/env node

if (process.env.OBU_ALLOW_WORKSPACE_CLI_PUBLISH === "1") {
  process.exit(0);
}

console.error(
  [
    "Refusing to publish packages/cli directly.",
    "P4 publishes a staged public @open-browser-use/cli wrapper plus platform payload packages;",
    "the workspace TypeScript CLI is an implementation artifact and still carries",
    "repo-mode metadata such as the Node 22 engine requirement.",
  ].join(" "),
);
process.exit(1);
