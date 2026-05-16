//! Names of every JSON-RPC method routed by `obu-host`.
//!
//! Mirror in `packages/sdk/src/wire/methods.ts`.

#![allow(missing_docs)]

// Health / introspection
pub const PING: &str = "ping";
pub const GET_INFO: &str = "getInfo";

// Tabs
pub const GET_TABS: &str = "getTabs";
pub const CREATE_TAB: &str = "createTab";
pub const FINALIZE_TABS: &str = "finalizeTabs";
pub const CLAIM_USER_TAB: &str = "claimUserTab";
pub const GET_USER_TABS: &str = "getUserTabs";
pub const NAME_SESSION: &str = "nameSession";

// Debugger / CDP
pub const ATTACH: &str = "attach";
pub const DETACH: &str = "detach";
pub const EXECUTE_CDP: &str = "executeCdp";
pub const MOVE_MOUSE: &str = "moveMouse";

// History
pub const GET_USER_HISTORY: &str = "getUserHistory";

// Lifecycle
pub const TURN_ENDED: &str = "turnEnded";
pub const CLEAR_LIFECYCLE_DIAGNOSTICS: &str = "clearLifecycleDiagnostics";
pub const EXECUTE_UNHANDLED_COMMAND: &str = "executeUnhandledCommand";

// Browser intent methods. Locator extensions keep the same
// `playwright_locator_*` family and are marked below.
pub const PLAYWRIGHT_LOCATOR_CLICK: &str = "playwright_locator_click";
pub const PLAYWRIGHT_LOCATOR_DBLCLICK: &str = "playwright_locator_dblclick";
pub const PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA: &str = "playwright_locator_download_media";
pub const PLAYWRIGHT_LOCATOR_FILL: &str = "playwright_locator_fill";
pub const PLAYWRIGHT_LOCATOR_PRESS: &str = "playwright_locator_press";
pub const PLAYWRIGHT_LOCATOR_WAIT_FOR: &str = "playwright_locator_wait_for";
pub const PLAYWRIGHT_LOCATOR_COUNT: &str = "playwright_locator_count";
pub const PLAYWRIGHT_LOCATOR_SELECT_OPTION: &str = "playwright_locator_select_option";
pub const PLAYWRIGHT_LOCATOR_SET_CHECKED: &str = "playwright_locator_set_checked";
pub const PLAYWRIGHT_LOCATOR_IS_VISIBLE: &str = "playwright_locator_is_visible";
pub const PLAYWRIGHT_LOCATOR_IS_ENABLED: &str = "playwright_locator_is_enabled";
pub const PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS: &str = "playwright_locator_all_text_contents";
pub const PLAYWRIGHT_LOCATOR_TEXT_CONTENT: &str = "playwright_locator_text_content";
pub const PLAYWRIGHT_LOCATOR_INNER_TEXT: &str = "playwright_locator_inner_text";
pub const PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE: &str = "playwright_locator_get_attribute";
pub const PLAYWRIGHT_LOCATOR_READ_ALL: &str = "playwright_locator_read_all";
// open-browser-use extensions implemented with the same selector/actionability helpers.
pub const PLAYWRIGHT_LOCATOR_HOVER: &str = "playwright_locator_hover";
pub const PLAYWRIGHT_LOCATOR_BOUNDING_BOX: &str = "playwright_locator_bounding_box";

pub const PLAYWRIGHT_SCREENSHOT: &str = "playwright_screenshot";
pub const PLAYWRIGHT_DOM_SNAPSHOT: &str = "playwright_dom_snapshot";
pub const PLAYWRIGHT_WAIT_FOR_TIMEOUT: &str = "playwright_wait_for_timeout";
pub const PLAYWRIGHT_WAIT_FOR_URL: &str = "playwright_wait_for_url";
pub const PLAYWRIGHT_WAIT_FOR_LOAD_STATE: &str = "playwright_wait_for_load_state";
pub const PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER: &str = "playwright_wait_for_file_chooser";
pub const PLAYWRIGHT_FILE_CHOOSER_SET_FILES: &str = "playwright_file_chooser_set_files";
pub const PLAYWRIGHT_WAIT_FOR_DOWNLOAD: &str = "playwright_wait_for_download";
pub const PLAYWRIGHT_DOWNLOAD_PATH: &str = "playwright_download_path";

// CUA coordinate facade (raw CDP Input.*)
pub const CUA_CLICK: &str = "cua_click";
pub const CUA_DBLCLICK: &str = "cua_dblclick";
pub const CUA_SCROLL: &str = "cua_scroll";
pub const CUA_TYPE: &str = "cua_type";
pub const CUA_KEYPRESS: &str = "cua_keypress";
pub const CUA_DRAG: &str = "cua_drag";
pub const CUA_MOVE: &str = "cua_move";
pub const CUA_DOWNLOAD_MEDIA: &str = "cua_download_media";

pub const TAB_CLIPBOARD_READ_TEXT: &str = "tab_clipboard_read_text";
pub const TAB_CLIPBOARD_WRITE_TEXT: &str = "tab_clipboard_write_text";
pub const TAB_CLIPBOARD_READ: &str = "tab_clipboard_read";
pub const TAB_CLIPBOARD_WRITE: &str = "tab_clipboard_write";

pub const DOM_CUA_GET_VISIBLE_DOM: &str = "dom_cua_get_visible_dom";
pub const DOM_CUA_CLICK: &str = "dom_cua_click";
pub const DOM_CUA_DOUBLE_CLICK: &str = "dom_cua_double_click";
pub const DOM_CUA_SCROLL: &str = "dom_cua_scroll";
pub const DOM_CUA_TYPE: &str = "dom_cua_type";
pub const DOM_CUA_KEYPRESS: &str = "dom_cua_keypress";
pub const DOM_CUA_DOWNLOAD_MEDIA: &str = "dom_cua_download_media";

pub const TAB_GOTO: &str = "tab_goto";
pub const TAB_RELOAD: &str = "tab_reload";
pub const TAB_BACK: &str = "tab_back";
pub const TAB_FORWARD: &str = "tab_forward";
pub const TAB_CLOSE: &str = "tab_close";
pub const TAB_SCREENSHOT: &str = "tab_screenshot";
pub const TAB_WAIT_FOR_URL: &str = "tab_wait_for_url";
pub const TAB_WAIT_FOR_LOAD_STATE: &str = "tab_wait_for_load_state";
pub const TAB_CONTENT_EXPORT: &str = "tab_content_export";
pub const TAB_URL: &str = "tab_url";
pub const TAB_TITLE: &str = "tab_title";

/// All inbound (SDK -> obu-host) method names. Used by dispatcher tests.
pub const ALL_INBOUND_METHODS: &[&str] = &[
    PING,
    GET_INFO,
    GET_TABS,
    CREATE_TAB,
    FINALIZE_TABS,
    CLAIM_USER_TAB,
    GET_USER_TABS,
    NAME_SESSION,
    ATTACH,
    DETACH,
    EXECUTE_CDP,
    MOVE_MOUSE,
    GET_USER_HISTORY,
    TURN_ENDED,
    CLEAR_LIFECYCLE_DIAGNOSTICS,
    EXECUTE_UNHANDLED_COMMAND,
    PLAYWRIGHT_LOCATOR_CLICK,
    PLAYWRIGHT_LOCATOR_DBLCLICK,
    PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA,
    PLAYWRIGHT_LOCATOR_FILL,
    PLAYWRIGHT_LOCATOR_PRESS,
    PLAYWRIGHT_LOCATOR_WAIT_FOR,
    PLAYWRIGHT_LOCATOR_COUNT,
    PLAYWRIGHT_LOCATOR_SELECT_OPTION,
    PLAYWRIGHT_LOCATOR_SET_CHECKED,
    PLAYWRIGHT_LOCATOR_IS_VISIBLE,
    PLAYWRIGHT_LOCATOR_IS_ENABLED,
    PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS,
    PLAYWRIGHT_LOCATOR_TEXT_CONTENT,
    PLAYWRIGHT_LOCATOR_INNER_TEXT,
    PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE,
    PLAYWRIGHT_LOCATOR_READ_ALL,
    PLAYWRIGHT_LOCATOR_HOVER,
    PLAYWRIGHT_LOCATOR_BOUNDING_BOX,
    PLAYWRIGHT_SCREENSHOT,
    PLAYWRIGHT_DOM_SNAPSHOT,
    PLAYWRIGHT_WAIT_FOR_TIMEOUT,
    PLAYWRIGHT_WAIT_FOR_URL,
    PLAYWRIGHT_WAIT_FOR_LOAD_STATE,
    PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
    PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
    PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
    PLAYWRIGHT_DOWNLOAD_PATH,
    CUA_CLICK,
    CUA_DBLCLICK,
    CUA_SCROLL,
    CUA_TYPE,
    CUA_KEYPRESS,
    CUA_DRAG,
    CUA_MOVE,
    CUA_DOWNLOAD_MEDIA,
    TAB_CLIPBOARD_READ_TEXT,
    TAB_CLIPBOARD_WRITE_TEXT,
    TAB_CLIPBOARD_READ,
    TAB_CLIPBOARD_WRITE,
    DOM_CUA_GET_VISIBLE_DOM,
    DOM_CUA_CLICK,
    DOM_CUA_DOUBLE_CLICK,
    DOM_CUA_SCROLL,
    DOM_CUA_TYPE,
    DOM_CUA_KEYPRESS,
    DOM_CUA_DOWNLOAD_MEDIA,
    TAB_GOTO,
    TAB_RELOAD,
    TAB_BACK,
    TAB_FORWARD,
    TAB_CLOSE,
    TAB_SCREENSHOT,
    TAB_WAIT_FOR_URL,
    TAB_WAIT_FOR_LOAD_STATE,
    TAB_CONTENT_EXPORT,
    TAB_URL,
    TAB_TITLE,
];
