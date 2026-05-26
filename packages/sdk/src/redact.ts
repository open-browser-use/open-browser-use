export type TraceValueKind = "text" | "secret" | "selector" | "number" | "url";

export type RedactedTraceValue = {
  kind: TraceValueKind;
  field?: string;
  value: string;
  secret?: boolean;
};

const SECRET_FIELD_PATTERN =
  /(password|passwd|token|otp|one[-_]?time|secret|api[-_]?key|authorization|cvv|ssn)/i;

export function isSecret(v: RedactedTraceValue): boolean {
  if (v.kind === "secret" || v.secret === true) return true;
  if (v.field && SECRET_FIELD_PATTERN.test(v.field)) return true;
  return false;
}

export function redactTraceValue(v: RedactedTraceValue): RedactedTraceValue {
  return isSecret(v) ? { ...v, value: "[redacted]" } : v;
}

export function redactTraceValues(values: RedactedTraceValue[]): RedactedTraceValue[] {
  return values.map(redactTraceValue);
}
