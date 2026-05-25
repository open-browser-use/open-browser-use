//! Token-lean post-processing of Playwright `mode:"ai"` ARIA snapshots.
//!
//! Drops unnamed `img` nodes, collapses semantically-empty
//! `generic`/`listitem`/`group` wrappers (hoisting their children), and strips
//! `[ref=…]`/`[cursor=…]` annotations. OBU addresses elements via Playwright
//! locators / dom_cua node ids, never ARIA refs, so stripping refs is lossless
//! for the model-facing snapshot. Output is normalized to 2-space indentation
//! (matching the `mode:"ai"` producer) and blank lines are dropped.
//!
//! Known limitations:
//! - An accessible name containing the literal ` [ref=` is mis-stripped.
//! - Pruning recurses to tree depth; a pathologically deep tree could overflow.

struct Node {
    line: String,
    children: Vec<Node>,
}

/// Prune a `mode:"ai"` ARIA snapshot. Non-snapshot text is returned unchanged.
pub(crate) fn prune_aria_snapshot(text: &str) -> String {
    // Only transform genuine snapshots; pass error/status strings through unchanged.
    let looks_like_snapshot =
        text.starts_with("- ") || text.contains("\n- ") || text.contains("\n  - ");
    if !looks_like_snapshot {
        return text.to_string();
    }

    let lines: Vec<(i64, &str)> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let trimmed = line.trim_start();
            let indent = (line.len() - trimmed.len()) as i64;
            (indent, trimmed)
        })
        .collect();

    let mut pos = 0usize;
    let forest = parse_forest(&lines, &mut pos, -1);
    let pruned = prune_forest(forest);

    let mut out = Vec::new();
    serialize_forest(&pruned, 0, &mut out);
    out.join("\n")
}

/// Build a node forest from indentation. Children are strictly more indented.
fn parse_forest(lines: &[(i64, &str)], pos: &mut usize, parent_indent: i64) -> Vec<Node> {
    let mut out = Vec::new();
    while *pos < lines.len() && lines[*pos].0 > parent_indent {
        let (indent, content) = lines[*pos];
        *pos += 1;
        let children = parse_forest(lines, pos, indent);
        out.push(Node {
            line: content.to_string(),
            children,
        });
    }
    out
}

/// Post-order prune: drop unnamed img, collapse generic/listitem/group
/// wrappers (hoist children), strip ref/cursor annotations.
fn prune_forest(nodes: Vec<Node>) -> Vec<Node> {
    let mut out = Vec::new();
    for node in nodes {
        let children = prune_forest(node.children);
        let line = strip_annotations(&node.line);
        if is_bare_role(&line, "img") {
            continue; // drop node and its (pruned) subtree
        }
        if is_bare_role(&line, "generic")
            || is_bare_role(&line, "listitem")
            || is_bare_role(&line, "group")
        {
            out.extend(children); // collapse wrapper, hoist children
            continue;
        }
        out.push(Node { line, children });
    }
    out
}

fn serialize_forest(nodes: &[Node], depth: usize, out: &mut Vec<String>) {
    let indent = "  ".repeat(depth);
    for node in nodes {
        out.push(format!("{indent}{}", node.line));
        serialize_forest(&node.children, depth + 1, out);
    }
}

/// Remove ` [ref=…]` and ` [cursor=…]` annotations.
fn strip_annotations(line: &str) -> String {
    let without_ref = remove_annotation(line, " [ref=");
    remove_annotation(&without_ref, " [cursor=")
}

fn remove_annotation(line: &str, marker: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.find(marker) {
        result.push_str(&rest[..idx]);
        let after = &rest[idx + marker.len()..];
        match after.find(']') {
            Some(close) => rest = &after[close + 1..],
            None => {
                // Malformed (no closing bracket): keep verbatim.
                result.push_str(&rest[idx..]);
                rest = "";
                break;
            }
        }
    }
    result.push_str(rest);
    result
}

/// True when `line` is `- <role>` followed only by ` [..]` groups and an
/// optional trailing `:` (i.e. a bare wrapper with no accessible name).
fn is_bare_role(line: &str, role: &str) -> bool {
    let Some(rest) = line.strip_prefix("- ") else {
        return false;
    };
    let Some(mut rest) = rest.strip_prefix(role) else {
        return false;
    };
    while let Some(inner) = rest.strip_prefix(" [") {
        match inner.find(']') {
            Some(close) => rest = &inner[close + 1..],
            None => return false,
        }
    }
    rest.is_empty() || rest == ":"
}

#[cfg(test)]
mod tests {
    use super::prune_aria_snapshot;

    #[test]
    fn drops_unnamed_img_nodes() {
        let input = "- button \"Save\"\n- img";
        assert_eq!(prune_aria_snapshot(input), "- button \"Save\"");
    }

    #[test]
    fn keeps_named_img() {
        let input = "- img \"Company logo\"";
        assert_eq!(prune_aria_snapshot(input), "- img \"Company logo\"");
    }

    #[test]
    fn collapses_generic_and_hoists_children() {
        let input = "- generic:\n  - button \"A\"\n  - button \"B\"";
        assert_eq!(prune_aria_snapshot(input), "- button \"A\"\n- button \"B\"");
    }

    #[test]
    fn collapses_listitem_and_group_under_kept_list() {
        let input = "- list:\n  - listitem:\n    - link \"Home\"\n  - group:\n    - link \"About\"";
        assert_eq!(
            prune_aria_snapshot(input),
            "- list:\n  - link \"Home\"\n  - link \"About\""
        );
    }

    #[test]
    fn strips_ref_and_cursor_annotations() {
        let input = "- button \"Save\" [ref=e5] [cursor=pointer]\n- textbox \"Email\" [ref=e6]";
        assert_eq!(
            prune_aria_snapshot(input),
            "- button \"Save\"\n- textbox \"Email\""
        );
    }

    #[test]
    fn nested_generics_collapse_to_top() {
        let input = "- generic:\n  - generic:\n    - button \"Deep\"";
        assert_eq!(prune_aria_snapshot(input), "- button \"Deep\"");
    }

    #[test]
    fn passes_through_non_snapshot_text() {
        let input = "plain status text\nno list markers here";
        assert_eq!(prune_aria_snapshot(input), input);
    }

    // Representative real-world-shaped snapshot: combines wrapper collapse,
    // unnamed-img drop, named-img keep, ref/cursor strip, and annotation
    // preservation (`[level=1]`) in one nested tree.
    #[test]
    fn prunes_representative_snapshot() {
        let input = "- banner:\n  - generic:\n    - img\n    - link \"Home\" [ref=e2] [cursor=pointer]\n- main:\n  - heading \"Title\" [level=1]\n  - list:\n    - listitem:\n      - link \"One\" [ref=e7]\n    - listitem:\n      - link \"Two\" [ref=e8]\n  - img \"Chart\"";
        let expected = "- banner:\n  - link \"Home\"\n- main:\n  - heading \"Title\" [level=1]\n  - list:\n    - link \"One\"\n    - link \"Two\"\n  - img \"Chart\"";
        assert_eq!(prune_aria_snapshot(input), expected);
    }

    #[test]
    fn prunes_to_empty_when_all_nodes_dropped() {
        assert_eq!(prune_aria_snapshot("- img"), "");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(prune_aria_snapshot(""), "");
    }
}
