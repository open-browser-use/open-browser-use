export class ObuError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ObuError";
  }

  get productError(): ProductErrorEntry | undefined {
    return productErrorFromData(this.data) ?? productErrorForRpcCode(this.code);
  }

  toJSON(): Record<string, unknown> {
    const productError = this.productError;
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.data !== undefined ? { data: this.data } : {}),
      ...(productError ? { product_error: productError } : {}),
    };
  }
}

export const ERR_TIMEOUT = -1000;
export const ERR_NOT_FOUND = -1001;
export const ERR_DISALLOWED = -1002;
export const ERR_NOT_IMPLEMENTED = -1003;
export const ERR_PROTOCOL = -1004;
export const ERR_NO_BACKEND = -1005;
export const ERR_OVERLOADED = -1006;
export const ERR_IO = -1099;
export const ERR_PEER_AUTH = -1100;
export const ERR_CAPABILITY_TOKEN = -1101;
export const ERR_CMD_DISALLOWED = -1102;
export const ERR_PAGE_CLOSED = -1200;
export const ERR_CDP_FAILURE = -1201;
export const ERR_TAB_NOT_ATTACHED = -1202;
export const ERR_DIALOG_REQUIRES_DECISION = -1203;

export const ERR_TRANSPORT_CLOSED = ERR_IO;

export type ProductErrorCode =
  | "setup_missing"
  | "browser_popup_boundary"
  | "native_host_broken"
  | "extension_id_mismatch"
  | "no_backend"
  | "stale_descriptor"
  | "timeout"
  | "disallowed_command"
  | "missing_handle"
  | "dialog_requires_decision"
  | "transport_closed";

export type ProductErrorNextAction = {
  kind:
    | "run_verify"
    | "run_repair"
    | "open_popup"
    | "select_profile"
    | "manual"
    | "stop_and_report";
  summary: string;
  command?: string;
};

export type ProductErrorEntry = {
  code: ProductErrorCode;
  title: string;
  summary: string;
  jsonRpcCodes: readonly number[];
  nextAction: ProductErrorNextAction;
};

export const PRODUCT_ERROR_MATRIX: readonly ProductErrorEntry[] = [
  {
    code: "setup_missing",
    title: "Setup is incomplete",
    summary: "The local CLI, SDK, runtime directory, or agent wiring is missing or not trusted.",
    jsonRpcCodes: [],
    nextAction: {
      kind: "run_verify",
      summary: "Run verify with the exact handoff target, using --repair when verify says repair is available.",
      command: "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
    },
  },
  {
    code: "browser_popup_boundary",
    title: "Browser popup action required",
    summary: "Local setup is valid, but the WebExtension has not exposed an active runtime descriptor yet.",
    jsonRpcCodes: [],
    nextAction: {
      kind: "open_popup",
      summary: "Open the open-browser-use extension popup, click Resume if enabled, then rerun verify.",
      command: "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
    },
  },
  {
    code: "native_host_broken",
    title: "Native host is broken",
    summary: "The browser native-host manifest, wrapper, allowed origin, or host executable is missing or stale.",
    jsonRpcCodes: [ERR_PEER_AUTH],
    nextAction: {
      kind: "run_repair",
      summary: "Repair the native host manifest and wrapper for the selected browser and extension.",
      command: "obu verify --repair --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
    },
  },
  {
    code: "extension_id_mismatch",
    title: "Extension id mismatch",
    summary: "The active browser descriptor or native-host manifest is bound to a different extension id.",
    jsonRpcCodes: [],
    nextAction: {
      kind: "run_repair",
      summary: "Verify with the extension id copied from the popup handoff, then repair if verify requests it.",
      command: "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
    },
  },
  {
    code: "no_backend",
    title: "No usable browser backend",
    summary: "No browser backend matching the requested browser, backend type, or socket path is available.",
    jsonRpcCodes: [ERR_NO_BACKEND],
    nextAction: {
      kind: "run_verify",
      summary: "Run verify for readiness, then follow its single next action.",
      command: "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
    },
  },
  {
    code: "stale_descriptor",
    title: "Runtime descriptor is stale",
    summary: "A browser runtime descriptor exists but no longer points at a usable live backend.",
    jsonRpcCodes: [],
    nextAction: {
      kind: "run_repair",
      summary: "Run browser doctor repair or reopen the popup so the extension publishes a fresh descriptor.",
      command: "obu doctor browser --repair",
    },
  },
  {
    code: "timeout",
    title: "Operation timed out",
    summary: "A defensive timeout elapsed before the host or browser operation returned.",
    jsonRpcCodes: [ERR_TIMEOUT],
    nextAction: {
      kind: "stop_and_report",
      summary: "Stop retrying blindly; report the timed-out operation and inspect browser_status or verify.",
    },
  },
  {
    code: "disallowed_command",
    title: "Command was disallowed",
    summary: "A command guard rejected the requested browser operation.",
    jsonRpcCodes: [ERR_DISALLOWED, ERR_CMD_DISALLOWED],
    nextAction: {
      kind: "manual",
      summary: "Do not retry the same command until the guard reason is understood or policy is changed.",
    },
  },
  {
    code: "missing_handle",
    title: "Browser handle is missing",
    summary: "The requested tab, page, target, locator, or backend handle no longer exists or is not attached.",
    jsonRpcCodes: [ERR_NOT_FOUND, ERR_PAGE_CLOSED, ERR_TAB_NOT_ATTACHED],
    nextAction: {
      kind: "manual",
      summary: "Refresh browser state, reacquire the handle, or stop if the user/browser closed it.",
    },
  },
  {
    code: "dialog_requires_decision",
    title: "Native dialog requires a decision",
    summary: "A confirm or prompt dialog was dismissed to avoid a hang and needs an explicit user or agent decision.",
    jsonRpcCodes: [ERR_DIALOG_REQUIRES_DECISION],
    nextAction: {
      kind: "stop_and_report",
      summary: "Stop the operation and report the dialog type, message summary, tab id, and dismissed default action.",
    },
  },
  {
    code: "transport_closed",
    title: "Transport closed",
    summary: "The native pipe, host process, or browser bridge closed before the request completed.",
    jsonRpcCodes: [ERR_TRANSPORT_CLOSED],
    nextAction: {
      kind: "run_verify",
      summary: "Check browser_status, then rerun verify if the backend is no longer available.",
      command: "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>",
    },
  },
] as const;

export function productErrorByCode(code: ProductErrorCode): ProductErrorEntry {
  return PRODUCT_ERROR_BY_CODE.get(code)!;
}

export function productErrorForRpcCode(code: number): ProductErrorEntry | undefined {
  return PRODUCT_ERROR_BY_RPC_CODE.get(code);
}

export function productErrorData(
  code: ProductErrorCode,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  const entry = productErrorByCode(code);
  return {
    code,
    product_error: {
      code: entry.code,
      title: entry.title,
      next_action: entry.nextAction,
    },
    ...details,
  };
}

function productErrorFromData(data: unknown): ProductErrorEntry | undefined {
  if (!isRecord(data)) return undefined;
  const directCode = typeof data.code === "string" ? data.code : undefined;
  if (directCode && isProductErrorCode(directCode)) return productErrorByCode(directCode);
  const product = data.product_error;
  if (isRecord(product) && typeof product.code === "string" && isProductErrorCode(product.code)) {
    return productErrorByCode(product.code);
  }
  return undefined;
}

function isProductErrorCode(code: string): code is ProductErrorCode {
  return PRODUCT_ERROR_BY_CODE.has(code as ProductErrorCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PRODUCT_ERROR_BY_CODE = new Map<ProductErrorCode, ProductErrorEntry>(
  PRODUCT_ERROR_MATRIX.map((entry) => [entry.code, entry]),
);

const PRODUCT_ERROR_BY_RPC_CODE = new Map<number, ProductErrorEntry>(
  PRODUCT_ERROR_MATRIX.flatMap((entry) => entry.jsonRpcCodes.map((code) => [code, entry] as const)),
);
