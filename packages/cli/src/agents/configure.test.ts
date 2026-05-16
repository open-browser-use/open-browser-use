import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configureAgents } from "./configure.js";
import type { McpServerInvocation } from "./registry.js";

test("configureAgents runs shell adapters found on PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "args.txt");
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh\necho "$@" > ${shellQuote(log)}\n`, "utf8");
  await chmod(codex, 0o755);

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: bin },
  });

  assert.equal(steps[0]?.status, "applied");
  assert.match(await readFile(log, "utf8"), /mcp add open-browser-use -- .* mcp stdio/);
});

test("configureAgents skips shell adapters when an equivalent server already exists", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "add.txt");
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  echo "open-browser-use ${shellEscapeForDoubleQuotes(path.join(root, "obu"))} mcp stdio"
  exit 0
fi
echo "$@" > ${shellQuote(log)}
`, "utf8");
  await chmod(codex, 0o755);

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: bin },
  });

  assert.equal(steps[0]?.status, "skipped");
  await assert.rejects(() => readFile(log, "utf8"), { code: "ENOENT" });
});

test("configureAgents returns manual action when shell executable is missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const steps = await configureAgents({
    agents: ["claude-code"],
    server: server(root),
    env: { PATH: "" },
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.match(steps[0]?.nextActions?.[0]?.value ?? "", /mcp-config --agent=claude-code --print/);
});

test("configureAgents writes JSONC direct-edit adapters and skips unchanged reruns", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await configureAgents({
    agents: ["zed"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    platform: "linux",
  });

  assert.equal(first[0]?.status, "applied");
  const configPath = path.join(root, ".config", "zed", "settings.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.context_servers["open-browser-use"].command, path.join(root, "obu"));
  assert.deepEqual(config.context_servers["open-browser-use"].args, ["mcp", "stdio"]);

  const second = await configureAgents({
    agents: ["zed"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    platform: "linux",
  });
  assert.equal(second[0]?.status, "skipped");
  assert.deepEqual(await readdir(path.dirname(configPath)), ["settings.json"]);
});

test("configureAgents direct-edit adapters create backups and retain only open-browser-use's newest five", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".codeium", "windsurf", "mcp_config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{\n  // keep user comments\n  \"mcpServers\": {}\n}\n", "utf8");

  for (let index = 0; index < 7; index += 1) {
    await configureAgents({
      agents: ["windsurf"],
      server: { name: "open-browser-use", command: path.join(root, `obu-${index}`), args: ["mcp", "stdio"] },
      env: { PATH: "" },
      homeDir: root,
      now: new Date(Date.UTC(2026, 4, 16, 12, 0, index)),
    });
  }

  const entries = await readdir(path.dirname(configPath));
  const openBrowserUseBackups = entries.filter((entry) => /^mcp_config\.json\.bak-\d{8}T\d{6}Z$/.test(entry));
  assert.equal(openBrowserUseBackups.length, 5);
  assert.equal(entries.some((entry) => entry.includes("20260516T120000Z")), false);
  assert.match(await readFile(configPath, "utf8"), /keep user comments/);
});

test("configureAgents skips broken JSONC direct-edit files with a manual action", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".cursor", "mcp.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{bad-json", "utf8");

  const steps = await configureAgents({
    agents: ["cursor"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.match(steps[0]?.message ?? "", /could not be parsed/);
  assert.match(steps[0]?.nextActions?.[0]?.value ?? "", /mcp-config --agent=cursor --print/);
});

test("configureAgents uses Cursor shell adapter only when --add-mcp is available", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "cursor-args.txt");
  const cursor = path.join(bin, "cursor");
  await writeFile(cursor, `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "usage: cursor --add-mcp"
  exit 0
fi
echo "$@" > ${shellQuote(log)}
`, "utf8");
  await chmod(cursor, 0o755);

  const steps = await configureAgents({
    agents: ["cursor"],
    server: server(root),
    env: { PATH: bin },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "applied");
  assert.match(await readFile(log, "utf8"), /--add-mcp/);
  await assert.rejects(() => readFile(path.join(root, ".cursor", "mcp.json"), "utf8"), { code: "ENOENT" });
});

function server(root: string): McpServerInvocation {
  return {
    name: "open-browser-use",
    command: path.join(root, "obu"),
    args: ["mcp", "stdio"],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellEscapeForDoubleQuotes(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}
