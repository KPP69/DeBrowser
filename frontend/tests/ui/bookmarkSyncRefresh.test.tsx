// Regression test for audit H-3 (BookmarksPageSync.tsx): the local
// `kind` in applyAndRefresh shadowed the outer search-kind state, so
// the refresh after a successful edit/delete passed "success" (or
// "warning"/"error"/"info") to SearchInstanceBookmarks instead of the
// original "bookmark"/"folder", and the backend rejected it with
// "搜索类型无效". The fix renames the local to `resultKind`.
// This test pins that the refresh call re-uses the original kind.
//
// Backend calls are faked with the runtime's public setTransport API
// (the generated bindings go through Call.ByID -> runtime transport),
// so no Wails backend is needed.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setTransport } from "@wailsio/runtime";
import SyncDialog from "../../src/pages/BookmarksPageSync.tsx";

// Binding method IDs from the generated
// bindings/.../internal/service/bookmarkservice.ts.
const SEARCH_ID = 4110893655;
const APPLY_EDIT_ID = 2457382095;

type TransportCall = { methodID: number; args: unknown[] };

const calls: TransportCall[] = [];

setTransport({
  call: async (_objectID: unknown, _method: unknown, _windowName: unknown, args: unknown) => {
    const { methodID, args: callArgs } = args as { methodID: number; args: unknown[] };
    calls.push({ methodID, args: callArgs });
    if (methodID === SEARCH_ID) {
      return {
        token: "tok-1",
        kind: callArgs[2],
        groups: [
          { key: "g1", name: "示例书签", url: "https://example.com/", instanceCount: 2 },
        ],
        uncheckedInstances: 0,
      };
    }
    if (methodID === APPLY_EDIT_ID) {
      return {
        updatedInstances: 2,
        failedInstances: 0,
        skippedInstances: 0,
        affectedNodes: 1,
        failedNodes: 0,
      };
    }
    // Record-only backend calls (e.g. RecordClientEvent) resolve empty.
    return null;
  },
});

function typeText(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function findButton(container: HTMLDivElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(btn, `button "${label}" not found`);
  return btn as HTMLButtonElement;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<SyncDialog nodes={[]} instances={[]} onClose={() => {}} />);
  });
  return { container, root };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

test("after a successful edit, the refresh search re-uses the original kind", async () => {
  calls.length = 0;
  const { container, root } = renderDialog();
  try {
    // Switch to the edit tab.
    act(() => {
      findButton(container, "编辑").click();
    });

    // Search for a bookmark (default kind is "bookmark").
    const searchInput = container.querySelector(
      'input[placeholder="输入书签名称或网址"]',
    ) as HTMLInputElement;
    assert.ok(searchInput, "search input not found");
    typeText(searchInput, "示例");
    act(() => {
      findButton(container, "搜索").click();
    });
    await flush();

    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    assert.ok(checkbox, "search result group checkbox not found");
    act(() => {
      checkbox.click();
    });

    // Apply the edit with a new name.
    const nameInput = container.querySelector(
      'input[placeholder="留空表示不修改名称"]',
    ) as HTMLInputElement;
    assert.ok(nameInput, "new-name input not found");
    typeText(nameInput, "改名后");
    act(() => {
      findButton(container, "确认修改所选 1 项").click();
    });
    await flush();

    const searches = calls.filter((c) => c.methodID === SEARCH_ID);
    assert.equal(searches.length, 2, "expected one search plus one refresh search");
    assert.equal(searches[0].args[2], "bookmark", "initial search must use kind bookmark");
    assert.equal(
      searches[1].args[2],
      "bookmark",
      "refresh search must re-use the original kind, not the apply result kind",
    );
  } finally {
    cleanup(root, container);
  }
});
