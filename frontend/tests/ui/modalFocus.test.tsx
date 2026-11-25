// Regression tests for the dialog focus behavior fixed in f9619a5.
// The bug: useDialogBehavior listed the (inline) onClose/onSubmit callbacks
// in its effect dependency array, so every keystroke re-rendered the parent,
// produced new callback identities, re-ran the effect and re-focused the
// dialog's first focusable element — the input lost focus after each char.
// The fix keeps callbacks in refs and runs the effect only when the dialog
// opens. These tests pin that behavior.
//
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
// tsx compiles this file with the classic JSX runtime unless told
// otherwise; the pragma below selects the automatic runtime (the same
// one the project tsconfig uses for src/).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "../../src/components/Modal.tsx";

// Mirrors the real call sites (e.g. ProxyConfigPage's add dialog): the
// input state lives in the parent, and onClose/onSubmit are inline arrow
// functions, so every keystroke creates new callback identities. A tab
// button precedes the input, so the first focusable element is NOT the
// input — that is what made the focus steal visible.
function TypingHarness({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Dialog open onClose={() => onClose()} onSubmit={() => onSubmit()}>
      <div>
        <button type="button">添加订阅</button>
        <button type="button">本地添加</button>
      </div>
      <label>
        名称
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
    </Dialog>
  );
}

function renderHarness(onClose: () => void, onSubmit: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TypingHarness onClose={onClose} onSubmit={onSubmit} />);
  });
  const input = container.querySelector("input") as HTMLInputElement;
  return { container, root, input };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

// Set the value the way a user typing does: through the native setter
// plus an input event, so React's onChange fires.
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

test("opening a dialog focuses its first focusable element", () => {
  const { container, root } = renderHarness(() => {}, () => {});
  try {
    const firstButton = container.querySelector("button") as HTMLButtonElement;
    assert.equal(document.activeElement, firstButton);
  } finally {
    cleanup(root, container);
  }
});

test("typing in a dialog input keeps focus on the input", () => {
  const { container, root, input } = renderHarness(() => {}, () => {});
  try {
    // The user clicks into the input first, as in real usage.
    act(() => {
      input.focus();
    });
    assert.equal(document.activeElement, input);

    typeText(input, "a");
    assert.equal(input.value, "a");
    assert.equal(document.activeElement, input);

    typeText(input, "ab");
    assert.equal(input.value, "ab");
    assert.equal(document.activeElement, input);

    typeText(input, "abc");
    assert.equal(input.value, "abc");
    assert.equal(document.activeElement, input);

    // An unrelated parent re-render (new inline callbacks, as happens on
    // every keystroke and on every poll tick) must not steal focus either.
    act(() => {
      root.render(<TypingHarness onClose={() => {}} onSubmit={() => {}} />);
    });
    assert.equal(document.activeElement, input);
  } finally {
    cleanup(root, container);
  }
});

test("Esc in a dialog calls onClose", () => {
  let closed = 0;
  const { container, root } = renderHarness(
    () => {
      closed += 1;
    },
    () => {},
  );
  try {
    act(() => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(closed, 1);
  } finally {
    cleanup(root, container);
  }
});

test("Enter in a dialog input calls onSubmit", () => {
  let submitted = 0;
  const { container, root, input } = renderHarness(
    () => {},
    () => {
      submitted += 1;
    },
  );
  try {
    act(() => {
      input.focus();
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    assert.equal(submitted, 1);
  } finally {
    cleanup(root, container);
  }
});

// Regression test for audit H-4: every DialogLayer registered its own
// Esc listener on document with only preventDefault, so one Esc closed
// all stacked dialogs at once and the lower form lost unsaved input.
// Only the topmost layer in the top-layer stack responds to Esc now.
function NestedHarness({
  onOuterClose,
  onInnerClose,
}: {
  onOuterClose: () => void;
  onInnerClose: () => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [value, setValue] = useState("已输入");
  return (
    <Dialog open onClose={() => onOuterClose()}>
      <label>
        名称
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button type="button" onClick={() => setInnerOpen(true)}>
        选择
      </button>
      {innerOpen && (
        <Dialog
          open
          onClose={() => {
            onInnerClose();
            setInnerOpen(false);
          }}
        >
          <p>选择器弹窗</p>
        </Dialog>
      )}
    </Dialog>
  );
}

test("Esc with two stacked dialogs closes only the top one", () => {
  let outerClosed = 0;
  let innerClosed = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <NestedHarness
        onOuterClose={() => {
          outerClosed += 1;
        }}
        onInnerClose={() => {
          innerClosed += 1;
        }}
      />,
    );
  });
  try {
    const input = container.querySelector("input") as HTMLInputElement;
    assert.equal(input.value, "已输入");
    // Type into the outer form first, so the test can prove the input
    // survives the Esc that closes the inner dialog.
    typeText(input, "已输入改");
    assert.equal(input.value, "已输入改");

    // Open the inner dialog afterwards, as in real usage (the form
    // opens first, the picker second): the inner dialog is pushed
    // on top of the layer stack.
    const pickButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "选择",
    ) as HTMLButtonElement;
    act(() => {
      pickButton.click();
    });
    assert.ok(container.textContent?.includes("选择器弹窗"));

    // One Esc: only the inner dialog closes; the outer form stays
    // open with its input intact.
    act(() => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(innerClosed, 1);
    assert.equal(outerClosed, 0);
    assert.ok(!container.textContent?.includes("选择器弹窗"));
    const stillThere = container.querySelector("input") as HTMLInputElement;
    assert.ok(stillThere, "outer form input must still be present");
    assert.equal(stillThere.value, "已输入改");

    // A second Esc now closes the outer dialog (it is topmost again).
    act(() => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(outerClosed, 1);
  } finally {
    cleanup(root, container);
  }
});
