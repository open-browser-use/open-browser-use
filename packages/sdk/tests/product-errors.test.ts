import { describe, expect, it } from "vitest";
import {
  ERR_DIALOG_REQUIRES_DECISION,
  ERR_NO_BACKEND,
  ERR_TIMEOUT,
  ERR_TRANSPORT_CLOSED,
  ObuError,
  PRODUCT_ERROR_MATRIX,
  productErrorByCode,
  productErrorData,
  productErrorForRpcCode,
} from "../src/errors.js";

describe("product error matrix", () => {
  it("keeps a stable JSON entry for each product error", () => {
    expect(JSON.parse(JSON.stringify(PRODUCT_ERROR_MATRIX))).toEqual([
      entry(
        "setup_missing",
        "Setup is incomplete",
        "The local CLI, SDK, runtime directory, or agent wiring is missing or not trusted.",
        [],
        "run_verify",
        "Run verify with the exact handoff target, using --repair when verify says repair is available.",
        "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
      ),
      entry(
        "browser_popup_boundary",
        "Browser popup action required",
        "Local setup is valid, but the WebExtension has not exposed an active runtime descriptor yet.",
        [],
        "open_popup",
        "Open the open-browser-use extension popup, click Resume if enabled, then rerun verify.",
        "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
      ),
      entry(
        "native_host_broken",
        "Native host is broken",
        "The browser native-host manifest, wrapper, allowed origin, or host executable is missing or stale.",
        [-1100],
        "run_repair",
        "Repair the native host manifest and wrapper for the selected browser and extension.",
        "obu verify --repair --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
      ),
      entry(
        "extension_id_mismatch",
        "Extension id mismatch",
        "The active browser descriptor or native-host manifest is bound to a different extension id.",
        [],
        "run_repair",
        "Verify with the extension id copied from the popup handoff, then repair if verify requests it.",
        "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
      ),
      entry(
        "no_backend",
        "No usable browser backend",
        "No browser backend matching the requested browser, backend type, or socket path is available.",
        [ERR_NO_BACKEND],
        "run_verify",
        "Run verify for readiness, then follow its single next action.",
        "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
      ),
      entry(
        "stale_descriptor",
        "Runtime descriptor is stale",
        "A browser runtime descriptor exists but no longer points at a usable live backend.",
        [],
        "run_repair",
        "Run browser doctor repair or reopen the popup so the extension publishes a fresh descriptor.",
        "obu doctor browser --repair",
      ),
      entry(
        "timeout",
        "Operation timed out",
        "A defensive timeout elapsed before the host or browser operation returned.",
        [ERR_TIMEOUT],
        "stop_and_report",
        "Stop retrying blindly; report the timed-out operation and inspect browser_status or verify.",
      ),
      entry(
        "disallowed_command",
        "Command was disallowed",
        "A command guard rejected the requested browser operation.",
        [-1002, -1102],
        "manual",
        "Do not retry the same command until the guard reason is understood or policy is changed.",
      ),
      entry(
        "missing_handle",
        "Browser handle is missing",
        "The requested tab, page, target, locator, or backend handle no longer exists or is not attached.",
        [-1001, -1200, -1202],
        "manual",
        "Refresh browser state, reacquire the handle, or stop if the user/browser closed it.",
      ),
      entry(
        "dialog_requires_decision",
        "Native dialog requires a decision",
        "A confirm or prompt dialog was dismissed to avoid a hang and needs an explicit user or agent decision.",
        [ERR_DIALOG_REQUIRES_DECISION],
        "stop_and_report",
        "Stop the operation and report the dialog type, message summary, tab id, and dismissed default action.",
      ),
      entry(
        "transport_closed",
        "Transport closed",
        "The native pipe, host process, or browser bridge closed before the request completed.",
        [ERR_TRANSPORT_CLOSED],
        "run_verify",
        "Check browser_status, then rerun verify if the backend is no longer available.",
        "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
      ),
    ]);
  });

  it("maps runtime rpc errors to product errors and preserves data on ObuError", () => {
    expect(productErrorForRpcCode(ERR_NO_BACKEND)?.code).toBe("no_backend");
    expect(productErrorForRpcCode(ERR_DIALOG_REQUIRES_DECISION)?.code).toBe("dialog_requires_decision");

    const data = productErrorData("dialog_requires_decision", {
      tab_id: "42",
      dialog_type: "confirm",
      default_action: "dismiss",
    });
    const error = new ObuError(ERR_DIALOG_REQUIRES_DECISION, "dialog_requires_decision", data);

    expect(error.code).toBe(ERR_DIALOG_REQUIRES_DECISION);
    expect(error.data).toBe(data);
    expect(error.productError?.code).toBe("dialog_requires_decision");
    expect(error.toJSON()).toMatchObject({
      code: ERR_DIALOG_REQUIRES_DECISION,
      data,
      product_error: productErrorByCode("dialog_requires_decision"),
    });
  });
});

function entry(
  code: string,
  title: string,
  summary: string,
  jsonRpcCodes: number[],
  nextActionKind: string,
  nextActionSummary: string,
  command?: string,
): Record<string, unknown> {
  return {
    code,
    title,
    summary,
    jsonRpcCodes,
    nextAction: {
      kind: nextActionKind,
      summary: nextActionSummary,
      ...(command ? { command } : {}),
    },
  };
}
