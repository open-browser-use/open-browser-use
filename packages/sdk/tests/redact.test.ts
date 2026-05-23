import { describe, expect, it } from "vitest";
import { isSecret, redactTraceValue, redactTraceValues } from "../src/redact.js";

describe("redactTraceValue", () => {
  it("redacts kind=secret", () => {
    expect(redactTraceValue({ kind: "secret", value: "hunter2" }).value).toBe("[redacted]");
  });

  it("preserves non-secret text", () => {
    expect(redactTraceValue({ kind: "text", value: "Acme Corp" }).value).toBe("Acme Corp");
  });

  it("respects an explicit secret=true marker", () => {
    expect(redactTraceValue({ kind: "text", value: "abc", secret: true }).value).toBe("[redacted]");
  });

  it("redacts canonical secret-bearing field names by default", () => {
    for (const field of ["password", "token", "otp", "apiKey", "ssn", "Authorization", "cvv"]) {
      expect(redactTraceValue({ kind: "text", field, value: "x" }).value).toBe("[redacted]");
    }
  });

  it("does not mutate the input value", () => {
    const input = { kind: "secret" as const, value: "hunter2" };
    redactTraceValue(input);
    expect(input.value).toBe("hunter2");
  });

  it("isSecret matches the redaction rule", () => {
    expect(isSecret({ kind: "secret", value: "x" })).toBe(true);
    expect(isSecret({ kind: "text", value: "x" })).toBe(false);
    expect(isSecret({ kind: "text", field: "password", value: "x" })).toBe(true);
  });

  it("redactTraceValues maps every entry", () => {
    const out = redactTraceValues([
      { kind: "text", field: "password", value: "p" },
      { kind: "text", field: "city", value: "NYC" },
    ]);
    expect(out.map((v) => v.value)).toEqual(["[redacted]", "NYC"]);
  });
});
