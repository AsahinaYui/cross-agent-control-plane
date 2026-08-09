import { describe, expect, it, vi } from "vitest";
import {
  isOverlayHitAtPoint,
  shouldOverlayAcceptMouse,
} from "./overlay-hit-test";

describe("isOverlayHitAtPoint", () => {
  it("finds an interactive ancestor from the pointer coordinates", () => {
    const hitArea = document.createElement("div");
    const child = document.createElement("span");
    hitArea.dataset.overlayHit = "";
    hitArea.append(child);
    const elementFromPoint = vi.fn(() => child);

    expect(isOverlayHitAtPoint({ elementFromPoint }, 120, 80)).toBe(true);
    expect(elementFromPoint).toHaveBeenCalledWith(120, 80);
  });

  it("returns false over transparent desktop space", () => {
    const elementFromPoint = vi.fn(() => document.body);

    expect(isOverlayHitAtPoint({ elementFromPoint }, 4, 9)).toBe(false);
  });

  it("keeps the whole overlay interactive while settings are open", () => {
    const elementFromPoint = vi.fn(() => document.body);

    expect(shouldOverlayAcceptMouse(true, { elementFromPoint }, 4, 9)).toBe(
      true,
    );
    expect(elementFromPoint).not.toHaveBeenCalled();
  });

  it("ignores the settings panel while its close animation is finishing", () => {
    const settings = document.createElement("div");
    settings.dataset.overlayHit = "";
    settings.dataset.overlaySettings = "";
    const child = document.createElement("button");
    settings.append(child);
    const elementFromPoint = vi.fn(() => child);

    expect(shouldOverlayAcceptMouse(false, { elementFromPoint }, 40, 20)).toBe(
      false,
    );
  });
});
