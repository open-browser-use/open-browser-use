#[test]
fn js_tool_description() {
    let body = include_str!("../resources/js_tool_description.md");
    insta::assert_snapshot!("js_tool_description", body);
}
