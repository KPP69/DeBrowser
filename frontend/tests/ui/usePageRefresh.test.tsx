// Tests for usePageRefresh (src/hooks/usePageRefresh.ts): the first
// activation after mount is skipped (the mount load already fetched),
// and each later return to the watched page refreshes exactly once.
// The hook reads the current page from useAppStore, so the tests drive
// navigation through the store's setPage, as the real app does.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePageRefresh } from "../../src/hooks/usePageRefresh.ts";
import { useAppStore, type PageKey } from "../../src/stores/useAppStore.ts";

function RefreshHarness({
  page,
  counter,
}: {
  page: PageKey;
  counter: { n: number };
}) {
  const refresh = useCallback(() => {
    counter.n += 1;
  }, [counter]);
  usePageRefresh(page, refresh);
  return null;
}

function renderHarness(page: PageKey, counter: { n: number }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RefreshHarness page={page} counter={counter} />);
  });
  return { container, root };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function goTo(page: PageKey) {
  act(() => {
    useAppStore.getState().setPage(page);
  });
}

test("first mount on the watched page does not refresh", () => {
  // Store starts on "instances"; mounting a watcher for that page is
  // the first activation, which the mount load already covers.
  goTo("instances");
  const counter = { n: 0 };
  const { container, root } = renderHarness("instances", counter);
  try {
    assert.equal(counter.n, 0, "mount alone must not refresh");
  } finally {
    cleanup(root, container);
  }
});

test("leaving and returning to the watched page refreshes exactly once", () => {
  goTo("instances");
  const counter = { n: 0 };
  const { container, root } = renderHarness("instances", counter);
  try {
    goTo("bookmarks");
    assert.equal(counter.n, 0, "leaving the page must not refresh");
    goTo("instances");
    assert.equal(counter.n, 1, "first return refreshes once");
    goTo("bookmarks");
    goTo("instances");
    assert.equal(counter.n, 2, "second return refreshes once more");
  } finally {
    cleanup(root, container);
  }
});

test("refresh fires only for the watched page", () => {
  goTo("instances");
  const counter = { n: 0 };
  const { container, root } = renderHarness("bookmarks", counter);
  try {
    // Mount while on another page consumes the first activation.
    assert.equal(counter.n, 0, "mount on another page must not refresh");
    goTo("bookmarks");
    assert.equal(counter.n, 1, "arriving at the watched page refreshes");
    goTo("instances");
    assert.equal(counter.n, 1, "leaving the watched page refreshes nothing");
  } finally {
    cleanup(root, container);
  }
});
