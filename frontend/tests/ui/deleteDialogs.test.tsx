// Tests for the delete confirmation dialogs extracted in phase 4
// (src/components/instances/DeleteDialogs.tsx): single-delete copy
// and the with-profile toggle, batch-delete counts, names and the
// skipped-instances note.
// Run with: npm test (node --test + tsx, JSDOM via ./setup.ts).
/** @jsxRuntime automatic */
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import DeleteDialogs from "../../src/components/instances/DeleteDialogs.tsx";
import { InstanceStatus } from "../../bindings/github.com/KPP69/DeBrowser/internal/model/index.ts";
import type { BatchPlanItem } from "../../src/pages/instancesLogic.ts";

const fakeInstance = {
  id: "i1",
  name: "测试浏览器",
  kernelId: "k1",
  kernelName: "Chrome",
  kernelVersion: "",
  kernelExecutablePath: "C:\\Program Files\\Chrome\\chrome.exe",
  userDataDir: "profiles/work",
  status: InstanceStatus.StatusStopped,
  startUrl: "",
  sortOrder: 0,
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
};

const batchPlan: BatchPlanItem[] = [
  { id: "a", name: "甲", status: "stopped", run: true, reason: "" },
  { id: "b", name: "乙", status: "stopped", run: true, reason: "" },
  { id: "c", name: "丙", status: "running", run: false, reason: "运行中，无法删除" },
];

function renderDialogs(props: {
  pendingDelete?: { instance: typeof fakeInstance; withProfile: boolean } | null;
  batchDeletePlan?: BatchPlanItem[] | null;
  onToggleWithProfile?: () => void;
  onConfirmSingle?: () => void;
  onConfirmBatch?: (plan: BatchPlanItem[]) => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DeleteDialogs
        pendingDelete={props.pendingDelete ?? null}
        onToggleWithProfile={props.onToggleWithProfile ?? (() => {})}
        onConfirmSingle={props.onConfirmSingle ?? (() => {})}
        onCancelSingle={() => {}}
        busy={false}
        batchDeletePlan={props.batchDeletePlan ?? null}
        onConfirmBatch={props.onConfirmBatch ?? (() => {})}
        onCancelBatch={() => {}}
        batchBusy={false}
      />,
    );
  });
  return { container, root };
}

function cleanup(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

test("single delete keeps profile by default and offers the destructive switch", () => {
  const { container, root } = renderDialogs({
    pendingDelete: { instance: fakeInstance, withProfile: false },
  });
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("删除实例「测试浏览器」"), "title names the instance");
    assert.ok(text.includes("会保留在磁盘上"), "impact says the profile is kept");
    assert.ok(text.includes("确认仅删除实例"), "confirm label is keep-profile");
    assert.ok(text.includes("改为同时删除实例文件"), "toggle to destructive delete offered");
  } finally {
    cleanup(root, container);
  }
});

test("single delete with profile warns it is unrecoverable", () => {
  const { container, root } = renderDialogs({
    pendingDelete: { instance: fakeInstance, withProfile: true },
  });
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("此操作不可恢复"), "impact warns unrecoverable");
    assert.ok(text.includes("确认删除实例及实例文件"), "confirm label is destructive");
    assert.ok(!text.includes("改为同时删除实例文件"), "no toggle once destructive");
  } finally {
    cleanup(root, container);
  }
});

test("batch delete shows runnable count, names and the skipped note", () => {
  const { container, root } = renderDialogs({ batchDeletePlan: batchPlan });
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("批量删除实例"), "batch title");
    assert.ok(text.includes("确认删除 2 个实例"), "confirm label counts runnable only");
    assert.ok(text.includes("甲") && text.includes("乙"), "runnable names listed");
    // "丙" appears exactly once: in the skipped note, not in the runnable list.
    assert.equal(text.split("丙").length - 1, 1, "skipped instance only in the note");
    assert.ok(text.includes("另有 1 个所选实例不会删除"), "skipped note counts the skipped");
    assert.ok(text.includes("「丙」运行中，无法删除"), "skipped note names the reason");
  } finally {
    cleanup(root, container);
  }
});

test("batch confirm passes the whole plan back to the page", () => {
  let received: BatchPlanItem[] | null = null;
  const { container, root } = renderDialogs({
    batchDeletePlan: batchPlan,
    onConfirmBatch: (plan) => {
      received = plan;
    },
  });
  try {
    const button = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("确认删除 2 个实例"),
    );
    assert.ok(button, "confirm button rendered");
    act(() => {
      button!.click();
    });
    assert.deepEqual(received, batchPlan);
  } finally {
    cleanup(root, container);
  }
});

test("no dialog renders when neither delete target is set", () => {
  const { container, root } = renderDialogs({});
  try {
    const text = container.textContent ?? "";
    assert.ok(!text.includes("删除实例"), "no single-delete dialog");
    assert.ok(!text.includes("批量删除"), "no batch-delete dialog");
  } finally {
    cleanup(root, container);
  }
});
