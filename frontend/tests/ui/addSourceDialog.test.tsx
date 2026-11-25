// Tests for the add-source dialog extracted in phase 4 step 4
// (src/components/proxy/AddSourceDialog.tsx): continuous typing and
// deleting keep focus, Esc closes, Enter submits, local validation
// errors show in the dialog, and a rejected submit surfaces the
// backend error without closing the dialog. The input state lives
// inside the dialog (see tests/ui/modalFocus.test.tsx for the
// regression this pins: parent re-renders must not steal focus).
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AddSourceDialog, {
  type AddSourceTab,
} from "../../src/components/proxy/AddSourceDialog.tsx";

type SubmitCall = { tab: AddSourceTab; name: string; url: string };

function renderDialog(props: {
  onClose?: () => void;
  onSubmit?: (tab: AddSourceTab, name: string, url: string) => Promise<void>;
  busy?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (onClose: () => void, onSubmit: (tab: AddSourceTab, name: string, url: string) => Promise<void>) => {
    act(() => {
      root.render(
        <AddSourceDialog
          open
          busy={props.busy ?? false}
          submitting={false}
          onClose={onClose}
          onSubmit={onSubmit}
        />,
      );
    });
  };
  render(props.onClose ?? (() => {}), props.onSubmit ?? (async () => {}));
  const nameInput = container.querySelector('input[placeholder="例如：我的订阅"]') as HTMLInputElement;
  const urlInput = container.querySelector('input[placeholder="https://…"]') as HTMLInputElement;
  return { container, root, render, nameInput, urlInput };
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

function buttonByText(container: HTMLDivElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  assert.ok(button, `expected a button labelled ${label}`);
  return button as HTMLButtonElement;
}

// Let the dialog's async submit (validation + onSubmit + error
// display) settle, flushing React state updates.
async function flushSubmit() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

test("typing the name keeps focus across keystrokes", () => {
  const { container, root, nameInput } = renderDialog({});
  try {
    act(() => {
      nameInput.focus();
    });
    assert.equal(document.activeElement, nameInput);

    typeText(nameInput, "我");
    assert.equal(nameInput.value, "我");
    assert.equal(document.activeElement, nameInput);

    typeText(nameInput, "我的");
    assert.equal(nameInput.value, "我的");
    assert.equal(document.activeElement, nameInput);

    typeText(nameInput, "我的订阅");
    assert.equal(nameInput.value, "我的订阅");
    assert.equal(document.activeElement, nameInput);
  } finally {
    cleanup(root, container);
  }
});

test("typing then deleting in the subscription URL keeps focus", () => {
  const { container, root, urlInput } = renderDialog({});
  try {
    act(() => {
      urlInput.focus();
    });
    assert.equal(document.activeElement, urlInput);

    typeText(urlInput, "https://example.com/sub");
    assert.equal(urlInput.value, "https://example.com/sub");
    assert.equal(document.activeElement, urlInput);

    // Deleting characters one by one must not move focus either.
    typeText(urlInput, "https://example.com/su");
    assert.equal(urlInput.value, "https://example.com/su");
    assert.equal(document.activeElement, urlInput);

    typeText(urlInput, "https://example.com/");
    assert.equal(urlInput.value, "https://example.com/");
    assert.equal(document.activeElement, urlInput);

    typeText(urlInput, "");
    assert.equal(urlInput.value, "");
    assert.equal(document.activeElement, urlInput);
  } finally {
    cleanup(root, container);
  }
});

test("a parent re-render with new callback identities does not steal focus", () => {
  const { container, root, render, nameInput } = renderDialog({});
  try {
    act(() => {
      nameInput.focus();
    });
    typeText(nameInput, "我的订阅");
    assert.equal(document.activeElement, nameInput);

    // New inline callbacks, as the page creates on every render.
    render(() => {}, async () => {});
    assert.equal(nameInput.value, "我的订阅");
    assert.equal(document.activeElement, nameInput);
  } finally {
    cleanup(root, container);
  }
});

test("Esc in the dialog calls onClose", () => {
  let closed = 0;
  const { container, root } = renderDialog({
    onClose: () => {
      closed += 1;
    },
  });
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

test("Enter in the name input submits with the typed values", async () => {
  const calls: SubmitCall[] = [];
  const { container, root, nameInput, urlInput } = renderDialog({
    onSubmit: async (tab, name, url) => {
      calls.push({ tab, name, url });
    },
  });
  try {
    typeText(nameInput, "我的订阅");
    typeText(urlInput, "https://example.com/sub");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      tab: "subscription",
      name: "我的订阅",
      url: "https://example.com/sub",
    });
  } finally {
    cleanup(root, container);
  }
});

test("Enter with an empty name shows an error and does not submit", async () => {
  const calls: SubmitCall[] = [];
  const { container, root, nameInput } = renderDialog({
    onSubmit: async (tab, name, url) => {
      calls.push({ tab, name, url });
    },
  });
  try {
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(calls.length, 0);
    assert.ok((container.textContent ?? "").includes("请填写名称。"));
  } finally {
    cleanup(root, container);
  }
});

test("subscription tab with an empty URL shows an error and does not submit", async () => {
  const calls: SubmitCall[] = [];
  const { container, root, nameInput } = renderDialog({
    onSubmit: async (tab, name, url) => {
      calls.push({ tab, name, url });
    },
  });
  try {
    typeText(nameInput, "我的订阅");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(calls.length, 0);
    assert.ok((container.textContent ?? "").includes("请填写订阅地址。"));
  } finally {
    cleanup(root, container);
  }
});

test("file tab submits without a URL", async () => {
  const calls: SubmitCall[] = [];
  const { container, root, nameInput } = renderDialog({
    onSubmit: async (tab, name, url) => {
      calls.push({ tab, name, url });
    },
  });
  try {
    act(() => {
      buttonByText(container, "本地添加").click();
    });
    // No URL field on the file tab; the hint paragraph shows instead.
    assert.equal(container.querySelector('input[placeholder="https://…"]'), null);
    assert.ok((container.textContent ?? "").includes("系统文件选择窗口"));

    typeText(nameInput, "本地配置");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { tab: "file", name: "本地配置", url: "" });
  } finally {
    cleanup(root, container);
  }
});

test("a rejected submit shows the backend error and keeps the dialog open", async () => {
  let attempts = 0;
  const { container, root, nameInput, urlInput } = renderDialog({
    onSubmit: async () => {
      attempts += 1;
      throw new Error("订阅不可达");
    },
  });
  try {
    typeText(nameInput, "我的订阅");
    typeText(urlInput, "https://example.com/sub");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(attempts, 1);
    assert.ok((container.textContent ?? "").includes("订阅不可达"));
    // The dialog stays open with its values: the name input is
    // still in the document and still holds the typed text.
    assert.ok(container.contains(nameInput));
    assert.equal(nameInput.value, "我的订阅");
  } finally {
    cleanup(root, container);
  }
});

test("clicking 取消 calls onClose", () => {
  let closed = 0;
  const { container, root } = renderDialog({
    onClose: () => {
      closed += 1;
    },
  });
  try {
    act(() => {
      buttonByText(container, "取消").click();
    });
    assert.equal(closed, 1);
  } finally {
    cleanup(root, container);
  }
});
