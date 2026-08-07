import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOverlayFocusability,
  createOverlayWindowOptions,
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

test("only editing mode focuses the overlay", () => {
  const calls = [],
    window = {
      setFocusable(value) {
        calls.push(["setFocusable", value]);
      },
      show() {
        calls.push(["show"]);
      },
      focus() {
        calls.push(["focus"]);
      },
      blur() {
        calls.push(["blur"]);
      },
    };
  applyOverlayFocusability(window, true);
  applyOverlayFocusability(window, false);
  assert.deepEqual(calls, [
    ["setFocusable", true],
    ["show"],
    ["focus"],
    ["blur"],
    ["setFocusable", false],
  ]);
});
