import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configureAgents, detectInstalledAgents } from "./configure.js";
import type { McpServerInvocation } from "./registry.js";

test("configureAgents runs shell adapters found on PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "args.txt");
  const claude = path.join(bin, "claude");
  await writeFile(claude, `#!/bin/sh\necho "$@" > ${shellQuote(log)}\n`, "utf8");
  await chmod(claude, 0o755);

  const steps = await configureAgents({
    agents: ["claude-code"],
    server: server(root),
    env: { PATH: bin },
  });

  assert.equal(steps[0]?.status, "applied");
  assert.match(await readFile(log, "utf8"), /mcp add -s user open-browser-use -- .* mcp stdio/);
});

test("configureAgents skips shell adapters when an equivalent server already exists", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "add.txt");
  const claude = path.join(bin, "claude");
  await writeFile(claude, `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  echo "open-browser-use ${shellEscapeForDoubleQuotes(path.join(root, "obu"))} mcp stdio"
  exit 0
fi
echo "$@" > ${shellQuote(log)}
`, "utf8");
  await chmod(claude, 0o755);

  const steps = await configureAgents({
    agents: ["claude-code"],
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

test("configureAgents times out hung shell adapters with a manual action", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell script fixture");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const claude = path.join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\nsleep 5\n", "utf8");
  await chmod(claude, 0o755);

  const steps = await configureAgents({
    agents: ["claude-code"],
    server: server(root),
    env: { PATH: bin },
    adapterTimeoutMs: 25,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.match(steps[0]?.message ?? "", /timed out/);
  assert.equal(steps[0]?.details?.timeout_ms, 25);
  assert.match(steps[0]?.nextActions?.[0]?.value ?? "", /mcp-config --agent=claude-code --print/);
});

test("configureAgents dry-run reports planned shell and direct-edit work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const steps = await configureAgents({
    agents: ["codex-cli", "zed"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    platform: "linux",
    dryRun: true,
  });

  assert.equal(steps.find((step) => step.id === "agent-codex-cli")?.status, "would_apply");
  assert.match(steps.find((step) => step.id === "agent-codex-cli")?.message ?? "", /would update codex-cli MCP config/);
  assert.equal(steps.find((step) => step.id === "agent-zed")?.status, "would_apply");
  assert.match(steps.find((step) => step.id === "agent-zed")?.message ?? "", /would update zed MCP config/);
});

test("configureAgents writes Codex global MCP config without requiring codex on PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(first[0]?.status, "applied");
  const configPath = path.join(root, ".codex", "config.toml");
  const config = await readFile(configPath, "utf8");
  assert.match(config, /\[mcp_servers\.open-browser-use\]/);
  assert.match(config, new RegExp(`command = "${escapeRegExp(path.join(root, "obu"))}"`));
  assert.match(config, /args = \["mcp", "stdio"\]/);

  const second = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });
  assert.equal(second[0]?.status, "skipped");
});

test("configureAgents refuses symlinked Codex config without changing the target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".codex", "config.toml");
  const target = path.join(root, "outside-codex.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(target, "do not change", "utf8");
  await symlink(target, configPath);

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.equal(steps[0]?.details?.code, "ELOOP");
  assert.equal(await readFile(target, "utf8"), "do not change");
});

test("configureAgents does not overwrite divergent Codex MCP config", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".codex", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, [
    "[mcp_servers.open-browser-use]",
    'command = "/custom/obu"',
    'args = ["mcp", "stdio"]',
    "",
  ].join("\n"), "utf8");

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.match(steps[0]?.message ?? "", /different settings/);
  assert.match(steps[0]?.nextActions?.[0]?.value ?? "", /mcp-config --agent=codex-cli --print/);
  const config = await readFile(configPath, "utf8");
  assert.match(config, /command = "\/custom\/obu"/);
  assert.doesNotMatch(config, new RegExp(escapeRegExp(path.join(root, "obu"))));
});

test("configureAgents does not append to malformed Codex config", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".codex", "config.toml");
  const malformed = "[broken\n";
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, malformed, "utf8");

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.match(steps[0]?.message ?? "", /could not be parsed/);
  assert.equal(steps[0]?.details?.code, "PARSE_ERROR");
  assert.match(steps[0]?.nextActions?.[0]?.value ?? "", /mcp-config --agent=codex-cli --print/);
  assert.equal(await readFile(configPath, "utf8"), malformed);
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

test("configureAgents refuses symlinked direct-edit config without changing the target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".cursor", "mcp.json");
  const target = path.join(root, "outside-cursor.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(target, "do not change", "utf8");
  await symlink(target, configPath);

  const steps = await configureAgents({
    agents: ["cursor"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.equal(steps[0]?.details?.code, "ELOOP");
  assert.equal(await readFile(target, "utf8"), "do not change");
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

test("configureAgents reports unreadable direct-edit files as manual actions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are required for this regression test");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  const configPath = path.join(root, ".cursor", "mcp.json");
  t.after(async () => {
    await chmod(configPath, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{}\n", "utf8");
  await chmod(configPath, 0o000);

  const steps = await configureAgents({
    agents: ["cursor"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
  });

  assert.equal(steps[0]?.status, "manual_action_required");
  assert.match(steps[0]?.message ?? "", /could not be read or written/);
  assert.equal(steps[0]?.details?.code, "EACCES");
});

test("configureAgents writes primary-browser instructions only when requested", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    writeInstructions: true,
  });

  assert.equal(steps.find((step) => step.id === "agent-codex-cli")?.status, "applied");
  const instructionStep = steps.find((step) => step.id === "agent-codex-cli-instructions");
  assert.equal(instructionStep?.status, "applied");
  assert.match(await readFile(path.join(root, ".codex", "AGENTS.md"), "utf8"), /primary BrowserUse\/browser automation tool/);

  const rerun = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    writeInstructions: true,
  });
  assert.equal(rerun.find((step) => step.id === "agent-codex-cli-instructions")?.status, "skipped");
});

test("configureAgents refuses symlinked primary instructions without changing the target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instructionPath = path.join(root, ".codex", "AGENTS.md");
  const target = path.join(root, "outside-agents.md");
  await mkdir(path.dirname(instructionPath), { recursive: true });
  await writeFile(target, "do not change", "utf8");
  await symlink(target, instructionPath);

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    writeInstructions: true,
  });
  const instructionStep = steps.find((step) => step.id === "agent-codex-cli-instructions");

  assert.equal(instructionStep?.status, "failed");
  assert.equal(instructionStep?.details?.code, "ELOOP");
  assert.equal(await readFile(target, "utf8"), "do not change");
});

test("configureAgents prefers an existing project instruction file over the global file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "AGENTS.md"), "# Project\n", "utf8");

  const steps = await configureAgents({
    agents: ["codex-cli"],
    server: server(root),
    env: { PATH: "" },
    homeDir: root,
    projectDir,
    writeInstructions: true,
  });

  const instructionStep = steps.find((step) => step.id === "agent-codex-cli-instructions");
  assert.equal(instructionStep?.status, "applied");
  assert.equal(instructionStep?.details?.kind, "project");
  assert.match(await readFile(path.join(projectDir, "AGENTS.md"), "utf8"), /primary BrowserUse\/browser automation tool/);
  await assert.rejects(() => readFile(path.join(root, ".codex", "AGENTS.md"), "utf8"), { code: "ENOENT" });
});

test("configureAgents writes Cursor config where agent doctor checks it", async (t) => {
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
  await assert.rejects(() => readFile(log, "utf8"), { code: "ENOENT" });
  const config = JSON.parse(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
  assert.equal(config.mcpServers["open-browser-use"].command, path.join(root, "obu"));
  assert.deepEqual(config.mcpServers["open-browser-use"].args, ["mcp", "stdio"]);
  assert.equal("name" in config.mcpServers["open-browser-use"], false);
});

test("detectInstalledAgents includes Codex config directories and Cursor executables", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-agent-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(path.join(root, ".codex"), { recursive: true });
  await mkdir(bin, { recursive: true });
  const cursor = path.join(bin, "cursor");
  await writeFile(cursor, "#!/bin/sh\n", "utf8");
  await chmod(cursor, 0o755);

  const agents = await detectInstalledAgents({
    env: { PATH: bin },
    homeDir: root,
    platform: "linux",
  });

  assert.equal(agents.includes("codex-cli"), true);
  assert.equal(agents.includes("cursor"), true);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
