// JSDOM environment for UI tests (tests/ui/*.test.tsx), run under
// `node --test` with tsx. Import this file FIRST in every UI test file,
// before any React import, so the DOM globals and the act() environment
// flag are in place before React loads.
//
// Each test file runs in its own node --test worker process, so the
// globals below are per-file and cannot leak between test files.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const { window } = dom;
const g = globalThis as Record<string, unknown>;

// Node 24 exposes some web globals (e.g. navigator) as getter-only
// properties on globalThis, so plain assignment throws. Define them
// explicitly instead.
function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

setGlobal("window", window);
setGlobal("document", window.document);
setGlobal("navigator", window.navigator);
setGlobal("HTMLElement", window.HTMLElement);
setGlobal("Element", window.Element);
setGlobal("Node", window.Node);
setGlobal("Event", window.Event);
setGlobal("KeyboardEvent", window.KeyboardEvent);
setGlobal("MouseEvent", window.MouseEvent);
setGlobal("getComputedStyle", window.getComputedStyle.bind(window));
setGlobal(
  "requestAnimationFrame",
  (cb: FrameRequestCallback): number =>
    window.setTimeout(() => cb(performance.now()), 0) as unknown as number,
);
setGlobal("cancelAnimationFrame", (id: number): void => window.clearTimeout(id));

// Tell React 18 that this environment supports act().
g.IS_REACT_ACT_ENVIRONMENT = true;

export { window };
