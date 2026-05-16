export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserInfo = {
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};
