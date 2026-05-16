export function display(value: unknown): unknown {
  const fn = (globalThis as { display?: (value: unknown) => unknown }).display;
  if (typeof fn !== "function") {
    throw new Error("global display() is not available");
  }
  return fn(value);
}
