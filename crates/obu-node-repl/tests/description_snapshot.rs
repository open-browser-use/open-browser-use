#[test]
fn js_tool_description() {
    let body = include_str!("../resources/js_tool_description.md");
    insta::assert_snapshot!("js_tool_description", body);
}

#[test]
fn agent_browser_mcp_usage_fast_work_rules() {
    let body = include_str!("../../../docs/agent-browser-mcp-usage.md");
    let required = [
        "Call `browser_status` before the first `js` cell",
        "Call `browser.name(\"short task label\")` early",
        "Keep a `Tab` handle and use `await tab.goto(url)`",
        "Reuse the last `tab.snapshotText()` result",
        "Avoid broad browser-boundary loops",
        "Arm `waitForEvent(\"download\")` or `waitForEvent(\"filechooser\")` before the",
        "Use `browser.turnEnded()` to mark a turn boundary",
        "`browser.finishTurn(...)` first finalizes tabs",
    ];
    let excerpt = required
        .iter()
        .map(|needle| {
            body.lines()
                .find(|line| line.contains(needle))
                .unwrap_or_else(|| panic!("missing agent browser usage rule: {needle}"))
                .trim()
        })
        .collect::<Vec<_>>()
        .join("\n");
    insta::assert_snapshot!("agent_browser_mcp_usage_fast_work_rules", excerpt);
}

#[test]
fn agent_install_prompt_fast_path_rules() {
    let body = include_str!("../../../prompts/agent-install-prompt.md");
    let fast_path = fenced_block_after(body, "Run the fast setup command.");
    let required = [
        "curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh",
        "\"$OBU\" setup --yes \\",
        "  --browser=<browser> \\",
        "  --channel=<extension-channel> \\",
        "  --extension-id=<extension-id> \\",
        "  --agents=<agent-id> \\",
        "  --write-instructions \\",
        "  --json",
        "\"$OBU\" verify \\",
        "  --agent=<agent-id> \\",
    ];
    for needle in required {
        assert!(
            fast_path.contains(needle),
            "missing agent install prompt fast-path rule: {needle}"
        );
    }

    let stop_rules = [
        "3. Stop when `verify` returns `result: ready`.",
        "Report the concise final state to the user. Do not run `doctor`,",
        "`bootstrap`, `verify --repair`, broad diagnostics, or extra MCP rewrites",
    ];
    let stop_excerpt = stop_rules
        .iter()
        .map(|needle| {
            body.lines()
                .find(|line| line.contains(needle))
                .unwrap_or_else(|| panic!("missing agent install prompt stop rule: {needle}"))
                .trim()
        })
        .collect::<Vec<_>>()
        .join("\n");

    insta::assert_snapshot!(
        "agent_install_prompt_fast_path_rules",
        format!("{}\n---\n{}", fast_path.trim(), stop_excerpt)
    );
}

#[test]
fn agent_install_prompt_closeout_rules() {
    let body = include_str!("../../../prompts/agent-install-prompt.md");
    let required = [
        "For setup probes, prefer `await browser.turnEnded()` after the probe",
        "Do not use `await browser.finishTurn({ keep: [] })` unless you intentionally",
    ];
    let excerpt = required
        .iter()
        .map(|needle| {
            body.lines()
                .find(|line| line.contains(needle))
                .unwrap_or_else(|| panic!("missing agent install prompt closeout rule: {needle}"))
                .trim()
        })
        .collect::<Vec<_>>()
        .join("\n");
    insta::assert_snapshot!("agent_install_prompt_closeout_rules", excerpt);
}

fn fenced_block_after(body: &str, marker: &str) -> String {
    let mut seen_marker = false;
    let mut in_block = false;
    let mut lines = Vec::new();
    for line in body.lines() {
        if !seen_marker {
            seen_marker = line.contains(marker);
            continue;
        }
        if !in_block {
            if line.trim() == "```sh" {
                in_block = true;
            }
            continue;
        }
        if line.trim() == "```" {
            return lines.join("\n");
        }
        lines.push(line);
    }
    panic!("missing fenced shell block after marker: {marker}");
}
