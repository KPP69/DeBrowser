// Tests for the instance form dialog
// (src/components/instances/InstanceFormDialog.tsx): empty-name
// validation and edit-mode initial values. The dialog keeps its own
// form state seeded from the `initial` prop; the page owns submit.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import InstanceFormDialog, {
  EMPTY_FORM,
  type FormState,
  type InstanceFormDialogProps,
} from "../../src/components/instances/InstanceFormDialog.tsx";
import { InstanceStatus, type Instance } from "../../bindings/github.com/KPP69/DeBrowser/internal/model/index.ts";
import type { BrowserView } from "../../bindings/github.com/KPP69/DeBrowser/internal/service/models.ts";

const browsers: BrowserView[] = [
  { id: "k1", name: "Chrome", executablePath: "C:\\Chrome\\chrome.exe", source: "manual" },
];

function fakeInstance(over: Partial<Instance> & { id: string; name: string }): Instance {
  return {
    kernelId: "k1",
    kernelName: "Chrome",
    kernelVersion: "120",
    kernelExecutablePath: "C:\\Chrome\\chrome.exe",
    userDataDir: "profiles/P-1",
    status: InstanceStatus.StatusStopped,
    startUrl: "",
    sortOrder: 0,
    createdAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
    ...over,
  };
}

function renderDialog(over: Partial<InstanceFormDialogProps> = {}) {
  const submitted: FormState[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <InstanceFormDialog
        editing={null}
        initial={EMPTY_FORM}
        browsers={browsers}
        browsersLoaded={true}
        browsersError={null}
        proxyNodes={[]}
        proxyBindings={[]}
        busy={false}
        pickerBusy={false}
        profileNote={null}
        appliedProfileName={null}
        onAppliedProfileName={() => {}}
        onOpenProfilePicker={() => {}}
        onClearProfileNote={() => {}}
        onNavigate={() => {}}
        onClose={() => {}}
        onCancel={() => {}}
        onSubmit={async (values) => {
          submitted.push(values);
        }}
        {...over}
      />,
    );
  });
  return { container, root, submitted };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function saveButton(container: HTMLDivElement) {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "保存",
  );
  assert.ok(btn, "save button rendered");
  return btn as HTMLButtonElement;
}

test("empty name shows an error and does not submit", () => {
  const { container, root, submitted } = renderDialog({
    initial: { ...EMPTY_FORM, name: "", browserId: "k1" },
  });
  try {
    act(() => {
      saveButton(container).click();
    });
    // The submit error carries the trailing 。, unlike the inline
    // hint shown under the empty input, so this pins the submit path.
    assert.ok(
      (container.textContent ?? "").includes("实例名称不能为空。"),
      "submit error shown for empty name",
    );
    assert.equal(submitted.length, 0, "onSubmit must not fire");
  } finally {
    cleanup(root, container);
  }
});

test("whitespace-only name also errors and does not submit", () => {
  const { container, root, submitted } = renderDialog({
    initial: { ...EMPTY_FORM, name: "   ", browserId: "k1" },
  });
  try {
    act(() => {
      saveButton(container).click();
    });
    assert.ok(
      (container.textContent ?? "").includes("实例名称不能为空。"),
      "submit error shown for whitespace-only name",
    );
    assert.equal(submitted.length, 0, "onSubmit must not fire");
  } finally {
    cleanup(root, container);
  }
});

test("edit mode seeds the form with the instance's initial values", () => {
  const editing = fakeInstance({ id: "i1", name: "工作号" });
  const initial: FormState = {
    id: "i1",
    name: "工作号",
    browserId: "k1",
    profileMode: "rename",
    profileName: "P-1",
    proxyNodeId: "",
  };
  const { container, root } = renderDialog({ editing, initial });
  try {
    assert.ok((container.textContent ?? "").includes("编辑实例"), "edit title rendered");
    const nameInput = container.querySelector(
      'input[placeholder="例如：工作号"]',
    ) as HTMLInputElement;
    assert.ok(nameInput, "name input rendered");
    assert.equal(nameInput.value, "工作号", "name seeded from initial");
    const kernelSelect = container.querySelector("select") as HTMLSelectElement;
    assert.ok(kernelSelect, "kernel select rendered");
    assert.equal(kernelSelect.value, "k1", "kernel seeded from initial");
    const profileInput = container.querySelector(
      'input[placeholder="新的实例文件名称"]',
    ) as HTMLInputElement;
    assert.ok(profileInput, "rename input rendered in rename mode");
    assert.equal(profileInput.value, "P-1", "profile name seeded from initial");
  } finally {
    cleanup(root, container);
  }
});

test("edit mode submit passes the seeded values through", () => {
  const editing = fakeInstance({ id: "i1", name: "工作号" });
  const initial: FormState = {
    id: "i1",
    name: "工作号",
    browserId: "k1",
    profileMode: "rename",
    profileName: "P-1",
    proxyNodeId: "",
  };
  const { container, root, submitted } = renderDialog({ editing, initial });
  try {
    act(() => {
      saveButton(container).click();
    });
    assert.equal(submitted.length, 1, "onSubmit fires once");
    assert.deepEqual(submitted[0], initial, "submitted values equal the initial form");
  } finally {
    cleanup(root, container);
  }
});
