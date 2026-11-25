// Tests for the bookmark delete bar extracted in phase 5 step 5
// (src/components/bookmarks/BookmarkDeleteBar.tsx): the two-stage
// confirm (删除所选 -> 确定删除 / 取消), the folder impact copy,
// and the counts behind it — selectionScope counts a folder's whole
// subtree once, even when a folder and its child are both selected.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BookmarkDeleteBar from "../../src/components/bookmarks/BookmarkDeleteBar.tsx";
import { selectionScope, type LibraryNodeLike } from "../../src/pages/bookmarksLogic.ts";

const nodes: LibraryNodeLike[] = [
  { id: "f1", kind: "folder", name: "工作", url: "", parentId: null, sortOrder: 0, createdAt: "2026-11-24T00:00:00Z" },
  { id: "b1", kind: "bookmark", name: "甲", url: "https://a.example/", parentId: "f1", sortOrder: 0, createdAt: "2026-11-24T00:00:00Z" },
  { id: "b2", kind: "bookmark", name: "乙", url: "https://b.example/", parentId: "f1", sortOrder: 1, createdAt: "2026-11-24T00:00:00Z" },
  { id: "b3", kind: "bookmark", name: "丙", url: "https://c.example/", parentId: null, sortOrder: 1, createdAt: "2026-11-24T00:00:00Z" },
];

function renderBar(props: {
  selected: ReadonlySet<string>;
  armed?: boolean;
  busy?: boolean;
  onArm?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  // The page derives these counts with selectionScope; the bar only
  // renders the copy that follows from them.
  const scope = selectionScope(nodes, props.selected);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <BookmarkDeleteBar
        selectedCount={scope.total}
        folderCount={scope.folders}
        busy={props.busy ?? false}
        armed={props.armed ?? false}
        onArm={props.onArm ?? (() => {})}
        onConfirm={props.onConfirm ?? (() => {})}
        onCancel={props.onCancel ?? (() => {})}
      />,
    );
  });
  return { container, root, scope };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function buttonByText(container: HTMLDivElement, label: string): HTMLButtonElement {
  // includes, not ===: the 删除所选 button also renders a lucide icon,
  // so its textContent carries surrounding whitespace.
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  assert.ok(button, `expected a button labelled ${label}`);
  return button as HTMLButtonElement;
}

test("nothing selected disables 删除所选", () => {
  const { container, root, scope } = renderBar({ selected: new Set() });
  try {
    assert.equal(scope.total, 0);
    const button = buttonByText(container, "删除所选");
    assert.equal(button.disabled, true);
    assert.ok(!(container.textContent ?? "").includes("确定删除"), "no confirm before arming");
  } finally {
    cleanup(root, container);
  }
});

test("one selected bookmark enables 删除所选 and arms without the folder warning", () => {
  const { container, root, scope } = renderBar({
    selected: new Set(["b3"]),
    armed: true,
  });
  try {
    assert.deepEqual(scope, { total: 1, bookmarks: 1, folders: 0 });
    const text = container.textContent ?? "";
    assert.ok(!text.includes("所选包含文件夹，其内容将一并删除"), "no folder warning for plain bookmarks");
    assert.ok(text.includes("确定删除"), "confirm shown once armed");
    assert.ok(text.includes("取消"), "cancel shown once armed");
  } finally {
    cleanup(root, container);
  }
});

test("a selected folder counts its whole subtree and warns its contents go with it", () => {
  const { container, root, scope } = renderBar({
    selected: new Set(["f1"]),
    armed: true,
  });
  try {
    // f1 + its two children: 3 items covered, 1 of them a folder.
    assert.deepEqual(scope, { total: 3, bookmarks: 2, folders: 1 });
    const text = container.textContent ?? "";
    assert.ok(text.includes("所选包含文件夹，其内容将一并删除"), "folder impact copy shown");
    assert.equal(text.split("所选包含文件夹，其内容将一并删除").length - 1, 1, "warning shown once");
  } finally {
    cleanup(root, container);
  }
});

test("a folder plus its child selected together are counted once", () => {
  const { container, root, scope } = renderBar({
    selected: new Set(["f1", "b1"]),
    armed: true,
  });
  try {
    // b1 is already inside f1's subtree: still 3 items, not 4.
    assert.deepEqual(scope, { total: 3, bookmarks: 2, folders: 1 });
    const text = container.textContent ?? "";
    assert.ok(text.includes("所选包含文件夹，其内容将一并删除"), "folder impact copy shown");
  } finally {
    cleanup(root, container);
  }
});

test("clicking 删除所选 arms the confirmation", () => {
  let armed = 0;
  const { container, root } = renderBar({
    selected: new Set(["b3"]),
    onArm: () => {
      armed += 1;
    },
  });
  try {
    act(() => {
      buttonByText(container, "删除所选").click();
    });
    assert.equal(armed, 1);
  } finally {
    cleanup(root, container);
  }
});

test("clicking 确定删除 calls onConfirm", () => {
  let confirmed = 0;
  const { container, root } = renderBar({
    selected: new Set(["f1"]),
    armed: true,
    onConfirm: () => {
      confirmed += 1;
    },
  });
  try {
    act(() => {
      buttonByText(container, "确定删除").click();
    });
    assert.equal(confirmed, 1);
  } finally {
    cleanup(root, container);
  }
});

test("clicking 取消 calls onCancel", () => {
  let cancelled = 0;
  const { container, root } = renderBar({
    selected: new Set(["b3"]),
    armed: true,
    onCancel: () => {
      cancelled += 1;
    },
  });
  try {
    act(() => {
      buttonByText(container, "取消").click();
    });
    assert.equal(cancelled, 1);
  } finally {
    cleanup(root, container);
  }
});

test("busy disables 确定删除 while armed", () => {
  const { container, root } = renderBar({
    selected: new Set(["b3"]),
    armed: true,
    busy: true,
  });
  try {
    assert.equal(buttonByText(container, "确定删除").disabled, true);
    assert.equal(buttonByText(container, "取消").disabled, true);
  } finally {
    cleanup(root, container);
  }
});
