import { describe, expect, it } from "vitest";
import {
  type CoordinateActionTarget,
  coordinateTargetCarriesVisualRevisions,
} from "../src/tab-action.js";

describe("coordinateTargetCarriesVisualRevisions", () => {
  it("returns true when all visual revision fields are present", () => {
    const target: CoordinateActionTarget = {
      source: "coordinate",
      x: 10,
      y: 20,
      observationId: "o1",
      annotationId: "an1",
      visualRevision: "v1",
      annotationRevision: "ar1",
    };
    expect(coordinateTargetCarriesVisualRevisions(target)).toBe(true);
  });

  it("returns false when visual revision fields are missing", () => {
    const target: CoordinateActionTarget = {
      source: "coordinate",
      x: 1,
      y: 2,
      observationId: "o1",
    };
    expect(coordinateTargetCarriesVisualRevisions(target)).toBe(false);
  });
});
