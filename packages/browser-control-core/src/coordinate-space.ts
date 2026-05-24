export const COORDINATE_SPACES = ["visualViewport", "layoutViewport"] as const;
export type CoordinateSpace = (typeof COORDINATE_SPACES)[number];
