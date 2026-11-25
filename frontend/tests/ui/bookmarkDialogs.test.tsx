// Tests for the bookmark dialogs extracted in phase 5 step 5
// (src/components/bookmarks/BookmarkDialogs.tsx): required-field
// validation, Esc closes, Enter submits, and the folder tab needs
// no URL. Input state lives inside the dialogs.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CreateBookmarkDialog,
  EditBookmarkDialog,
  type CreateBookmarkInput,
  type FolderOption,
  type UpdateBookmarkInput,
} from "../../src/components/bookmarks/BookmarkDialogs.tsx";

const folders: FolderOption[] = [
  { id: "f1", name: "工作", depth: 0 },
  { id: "f2", name: "子文件夹", depth: 1 },
];

function renderCreate(props: {
  onClose?: () => void;
  onSubmit?: (input: CreateBookmarkInput) => Promise<void>;
  busy?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CreateBookmarkDialog
        folders={folders}
        busy={props.busy ?? false}
        onClose={props.onClose ?? (() => {})}
        onSubmit={props.onSubmit ?? (async () => {})}
      />,
    );
  });
  const nameInput = container.querySelector('input[placeholder="书签名称"]') as HTMLInputElement;
  const urlInput = container.querySelector('input[placeholder="https://example.com/"]') as HTMLInputElement;
  return { container, root, nameInput, urlInput };
}

function renderEdit(props: {
  node?: { id: string; kind: string; name: string; url: string; parentId?: string | null };
  onClose?: () => void;
  onSubmit?: (input: UpdateBookmarkInput) => Promise<void>;
  busy?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <EditBookmarkDialog
        node={
          props.node ?? {
            id: "b1",
            kind: "bookmark",
            name: "旧名",
            url: "https://old.example/",
            parentId: "f1",
          }
        }
        folders={folders}
        busy={props.busy ?? false}
        onClose={props.onClose ?? (() => {})}
        onSubmit={props.onSubmit ?? (async () => {})}
      />,
    );
  });
  const inputs = container.querySelectorAll("input");
  return { container, root, nameInput: inputs[0] as HTMLInputElement, urlInput: inputs[1] as HTMLInputElement };
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

function selectOption(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
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

function pressEsc() {
  act(() => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

test("typing the name keeps focus across keystrokes", () => {
  const { container, root, nameInput } = renderCreate({});
  try {
    act(() => {
      nameInput.focus();
    });
    assert.equal(document.activeElement, nameInput);

    typeText(nameInput, "我");
    assert.equal(nameInput.value, "我");
    assert.equal(document.activeElement, nameInput);

    typeText(nameInput, "我的书签");
    assert.equal(nameInput.value, "我的书签");
    assert.equal(document.activeElement, nameInput);
  } finally {
    cleanup(root, container);
  }
});

test("Enter with an empty name shows an error and does not submit", async () => {
  const calls: CreateBookmarkInput[] = [];
  const { container, root, nameInput } = renderCreate({
    onSubmit: async (input) => {
      calls.push(input);
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

test("bookmark tab with an empty URL shows an error and does not submit", async () => {
  const calls: CreateBookmarkInput[] = [];
  const { container, root, nameInput } = renderCreate({
    onSubmit: async (input) => {
      calls.push(input);
    },
  });
  try {
    typeText(nameInput, "我的书签");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(calls.length, 0);
    assert.ok((container.textContent ?? "").includes("请填写网址。"));
  } finally {
    cleanup(root, container);
  }
});

test("Enter in the URL input submits with the typed values", async () => {
  const calls: CreateBookmarkInput[] = [];
  const { container, root, nameInput, urlInput } = renderCreate({
    onSubmit: async (input) => {
      calls.push(input);
    },
  });
  try {
    typeText(nameInput, "我的书签");
    typeText(urlInput, "https://example.com/");
    act(() => {
      urlInput.focus();
    });
    pressEnter(urlInput);
    await flushSubmit();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      kind: "bookmark",
      name: "我的书签",
      url: "https://example.com/",
      parentId: null,
    });
  } finally {
    cleanup(root, container);
  }
});

test("folder tab submits without a URL and honors the parent folder", async () => {
  const calls: CreateBookmarkInput[] = [];
  const { container, root, nameInput } = renderCreate({
    onSubmit: async (input) => {
      calls.push(input);
    },
  });
  try {
    act(() => {
      buttonByText(container, "文件夹").click();
    });
    // No URL field on the folder tab.
    assert.equal(container.querySelector('input[placeholder="https://example.com/"]'), null);

    typeText(nameInput, "新文件夹");
    selectOption(container.querySelector("select") as HTMLSelectElement, "f1");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      kind: "folder",
      name: "新文件夹",
      url: "",
      parentId: "f1",
    });
  } finally {
    cleanup(root, container);
  }
});

test("Esc in the create dialog calls onClose", () => {
  let closed = 0;
  const { container, root } = renderCreate({
    onClose: () => {
      closed += 1;
    },
  });
  try {
    pressEsc();
    assert.equal(closed, 1);
  } finally {
    cleanup(root, container);
  }
});

test("clicking 取消 in the create dialog calls onClose", () => {
  let closed = 0;
  const { container, root } = renderCreate({
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

test("a rejected create submit shows the backend error and keeps the dialog open", async () => {
  let attempts = 0;
  const { container, root, nameInput, urlInput } = renderCreate({
    onSubmit: async () => {
      attempts += 1;
      throw new Error("名称已存在");
    },
  });
  try {
    typeText(nameInput, "我的书签");
    typeText(urlInput, "https://example.com/");
    act(() => {
      nameInput.focus();
    });
    pressEnter(nameInput);
    await flushSubmit();
    assert.equal(attempts, 1);
    assert.ok((container.textContent ?? "").includes("名称已存在"));
    assert.ok(container.contains(nameInput));
    assert.equal(nameInput.value, "我的书签");
  } finally {
    cleanup(root, container);
  }
});

test("edit renders the node's name and URL", () => {
  const { container, root, nameInput, urlInput } = renderEdit({});
  try {
    assert.equal(nameInput.value, "旧名");
    assert.equal(urlInput.value, "https://old.example/");
    assert.ok((container.textContent ?? "").includes("编辑书签"));
    assert.ok((container.textContent ?? "").includes("编辑只修改资源库，不会修改已同步到实例中的书签。"));
  } finally {
    cleanup(root, container);
  }
});

test("edit with an empty name shows an error and does not submit", async () => {
  const calls: UpdateBookmarkInput[] = [];
  const { container, root, nameInput } = renderEdit({
    onSubmit: async (input) => {
      calls.push(input);
    },
  });
  try {
    typeText(nameInput, "");
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

test("edit with an empty URL shows an error and does not submit", async () => {
  const calls: UpdateBookmarkInput[] = [];
  const { container, root, nameInput, urlInput } = renderEdit({
    onSubmit: async (input) => {
      calls.push(input);
    },
  });
  try {
    typeText(nameInput, "新名");
    typeText(urlInput, "");
    act(() => {
      urlInput.focus();
    });
    pressEnter(urlInput);
    await flushSubmit();
    assert.equal(calls.length, 0);
    assert.ok((container.textContent ?? "").includes("请填写网址。"));
  } finally {
    cleanup(root, container);
  }
});

test("Enter submits the edited values with the original parent kept", async () => {
  const calls: UpdateBookmarkInput[] = [];
  const { container, root, nameInput, urlInput } = renderEdit({
    onSubmit: async (input) => {
      calls.push(input);
    },
  });
  try {
    typeText(nameInput, "新名");
    typeText(urlInput, "https://new.example/");
    act(() => {
      urlInput.focus();
    });
    pressEnter(urlInput);
    await flushSubmit();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      id: "b1",
      name: "新名",
      url: "https://new.example/",
      parentId: "f1",
    });
  } finally {
    cleanup(root, container);
  }
});

test("editing a folder shows no URL field and the folder title", () => {
  const { container, root } = renderEdit({
    node: { id: "f1", kind: "folder", name: "工作", url: "", parentId: null },
  });
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("编辑文件夹"), "folder title");
    assert.ok(!text.includes("网址"), "no URL field for folders");
  } finally {
    cleanup(root, container);
  }
});

test("Esc in the edit dialog calls onClose", () => {
  let closed = 0;
  const { container, root } = renderEdit({
    onClose: () => {
      closed += 1;
    },
  });
  try {
    pressEsc();
    assert.equal(closed, 1);
  } finally {
    cleanup(root, container);
  }
});
