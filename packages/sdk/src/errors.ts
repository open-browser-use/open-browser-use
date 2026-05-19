export class ObuError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ObuError";
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

export const ERR_TRANSPORT_CLOSED = ERR_IO;
