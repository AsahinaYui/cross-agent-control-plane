import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOverlayFocusability,
  createOverlayWindowOptions,
  shouldOverlayCapturePointer,
} from "./control-plane-overlay-window.mjs";

test("the transparent overlay starts visible without taking desktop focus", () => {
  const options = createOverlayWindowOptions({
    area: { x: 10, y: 20, width: 1440, height: 900 },
    preloadPath: "overlay-preload.cjs",
    iconPath: "icon.png",
  });
  assert.equal(options.focusable, false);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.transparent, true);
  assert.deepEqual(
    [options.x, options.y, options.width, options.height],
    [10, 20, 1440, 900],
  );
});

test("editing mode becomes focusable without stealing desktop focus", () => {
  const calls = [],
    window = {
      setFocusable(value) {
        calls.push(["setFocusable", value]);
      },
      isFocused() {
        calls.push(["isFocused"]);
        return false;
      },
      blur() {
        calls.push(["blur"]);
      },
    };
  applyOverlayFocusability(window, true);
  applyOverlayFocusability(window, false);
  assert.deepEqual(calls, [
    ["setFocusable", true],
    ["isFocused"],
    ["setFocusable", false],
  ]);
});

test("leaving editing mode releases focus without hiding the overlay", () => {
  const calls = [],
    window = {
      setFocusable(value) {
        calls.push(["setFocusable", value]);
      },
      isFocused() {
        calls.push(["isFocused"]);
        return true;
      },
      blur() {
        calls.push(["blur"]);
      },
    };
  applyOverlayFocusability(window, false);
  assert.deepEqual(calls, [["isFocused"], ["setFocusable", false], ["blur"]]);
});

test("main-process hit testing restores interaction over a visible module", () => {
  const state = {
    editing: false,
    windowBounds: { x: 100, y: 50, width: 1200, height: 800 },
    hitRegions: [{ x: 30, y: 40, width: 240, height: 160 }],
  };
  assert.equal(
    shouldOverlayCapturePointer({
      ...state,
      cursor: { x: 180, y: 140 },
    }),
    true,
  );
  assert.equal(
    shouldOverlayCapturePointer({
      ...state,
      cursor: { x: 600, y: 500 },
    }),
    false,
  );
});

test("settings editing mode captures input across the transparent window", () => {
  assert.equal(
    shouldOverlayCapturePointer({
      editing: true,
      windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
      cursor: { x: 1100, y: 700 },
      hitRegions: [],
    }),
    true,
  );
});
