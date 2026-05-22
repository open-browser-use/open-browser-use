import { PRODUCT_ERROR_SCHEMA } from "./product_errors.generated.js";

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

export type ProductErrorEntry = (typeof PRODUCT_ERROR_SCHEMA)[number];
export type ProductErrorCode = ProductErrorEntry["code"];
export type ProductErrorNextAction = ProductErrorEntry["nextAction"];

export const PRODUCT_ERROR_MATRIX: readonly ProductErrorEntry[] = PRODUCT_ERROR_SCHEMA;

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
