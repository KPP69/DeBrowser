// Tests for the instance table extracted in phase 8
// (src/components/instances/InstanceTable.tsx): row rendering
// (name, kernel, proxy node, status), selection, start/stop,
// edit/delete callbacks, and the loading/error/empty states.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import InstanceTable, { type InstanceTableProps } from "../../src/components/instances/InstanceTable.tsx";
import { InstanceStatus, type Instance } from "../../bindings/github.com/KPP69/DeBrowser/internal/model/index.ts";
import type { BindingView } from "../../bindings/github.com/KPP69/DeBrowser/internal/service/models.ts";

function fakeInstance(over: Partial<Instance> & { id: string; name: string }): Instance {
  return {
    kernelId: "k1",
    kernelName: "Chrome",
    kernelVersion: "120",
    kernelExecutablePath: "C:\\Chrome\\chrome.exe",
    userDataDir: "profiles/work",
    status: InstanceStatus.StatusStopped,
    startUrl: "",
    sortOrder: 0,
    createdAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
    ...over,
  };
}

const stopped = fakeInstance({ id: "i1", name: "甲" });
const running = fakeInstance({ id: "i2", name: "乙", status: InstanceStatus.StatusRunning });

const bindings: BindingView[] = [
  { instanceId: "i1", nodeId: "n1", nodeName: "节点A", sourceName: "订阅B", listenPort: 18081 },
];

function renderTable(over: Partial<InstanceTableProps> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <InstanceTable
        instances={[stopped, running]}
        displayInstances={[stopped, running]}
        loading={false}
        instancesError={null}
        onRetryLoad={record("retry")}
        selectedIds={new Set()}
        allSelected={false}
        batchBusy={false}
        browsersLoaded={true}
        actingId={null}
        proxyBindings={bindings}
        onToggleSelected={record("toggleSelected")}
        onToggleSelectAll={record("toggleSelectAll")}
        onRunAction={record("runAction")}
        onEdit={record("edit")}
        onDelete={record("delete")}
        {...over}
      />,
    );
  });
  return { container, root, calls };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function buttonByTitle(container: HTMLDivElement, title: string) {
  const btn = container.querySelector(`button[title="${title}"]`);
  assert.ok(btn, `button titled ${title} rendered`);
  return btn as HTMLButtonElement;
}

test("rows show name, kernel, proxy node and status label", () => {
  const { container, root } = renderTable();
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("甲") && text.includes("乙"), "instance names rendered");
    assert.ok(text.includes("Chrome 120"), "kernel name + version rendered");
    assert.ok(text.includes("节点A（订阅B）"), "proxy column reads the binding's node/source names");
    assert.ok(text.includes("未设置"), "instance without a binding shows 未设置");
    assert.ok(text.includes("已关闭"), "stopped status label rendered");
    assert.ok(text.includes("运行中"), "running status label rendered");
  } finally {
    cleanup(root, container);
  }
});

test("row checkbox and select-all call back with the right values", () => {
  const { container, root, calls } = renderTable();
  try {
    const rowBox = container.querySelector('input[aria-label="选择实例 甲"]') as HTMLInputElement;
    assert.ok(rowBox, "row checkbox rendered");
    act(() => {
      rowBox.click();
    });
    assert.deepEqual(calls[0], { name: "toggleSelected", args: ["i1", true] });
    const allBox = container.querySelector('input[aria-label="全选"]') as HTMLInputElement;
    act(() => {
      allBox.click();
    });
    assert.deepEqual(calls[1], { name: "toggleSelectAll", args: [true] });
  } finally {
    cleanup(root, container);
  }
});

test("start and stop buttons call runAction with the right kind", () => {
  const { container, root, calls } = renderTable();
  try {
    act(() => {
      buttonByTitle(container, "启动").click();
    });
    assert.equal(calls[0]?.name, "runAction");
    assert.equal((calls[0]?.args[0] as Instance).id, "i1");
    assert.equal(calls[0]?.args[1], "start");
    act(() => {
      buttonByTitle(container, "关闭").click();
    });
    assert.equal((calls[1]?.args[0] as Instance).id, "i2");
    assert.equal(calls[1]?.args[1], "stop");
  } finally {
    cleanup(root, container);
  }
});

test("edit and delete buttons call back; running instance cannot be deleted", () => {
  const { container, root, calls } = renderTable();
  try {
    const editButtons = [...container.querySelectorAll('button[title="编辑"]')];
    assert.equal(editButtons.length, 2, "one edit button per row");
    act(() => {
      (editButtons[0] as HTMLButtonElement).click();
    });
    assert.equal(calls[0]?.name, "edit");
    assert.equal((calls[0]?.args[0] as Instance).id, "i1");
    const deleteButtons = [...container.querySelectorAll('button[title="删除实例"], button[title="实例运行期间不能删除"]')];
    assert.equal(deleteButtons.length, 2, "one delete button per row");
    const runningDelete = deleteButtons[1] as HTMLButtonElement;
    assert.equal(runningDelete.title, "实例运行期间不能删除");
    assert.equal(runningDelete.disabled, true, "running instance delete is disabled");
    act(() => {
      (deleteButtons[0] as HTMLButtonElement).click();
    });
    assert.equal(calls[1]?.name, "delete");
    assert.equal((calls[1]?.args[0] as Instance).id, "i1");
  } finally {
    cleanup(root, container);
  }
});

test("loading, error and empty states render", () => {
  const loading = renderTable({ loading: true });
  try {
    assert.ok((loading.container.textContent ?? "").includes("加载中…"), "loading text");
  } finally {
    cleanup(loading.root, loading.container);
  }
  const errored = renderTable({ instances: [], displayInstances: [], instancesError: "boom" });
  try {
    assert.ok((errored.container.textContent ?? "").includes("实例列表加载失败：boom"), "error text");
    const retry = [...errored.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("重新加载"),
    );
    assert.ok(retry, "retry button rendered");
    act(() => {
      retry!.click();
    });
    assert.equal(errored.calls[0]?.name, "retry");
  } finally {
    cleanup(errored.root, errored.container);
  }
  const empty = renderTable({ instances: [], displayInstances: [] });
  try {
    assert.ok((empty.container.textContent ?? "").includes("暂无浏览器实例"), "empty text");
  } finally {
    cleanup(empty.root, empty.container);
  }
});
