// Top toolbar for the instances page: the create group
// （新建实例 / 批量创建）, the batch-action group （批量启动 /
// 批量关闭 / 批量删除 / 取消选择）, the batch-progress line and
// the poll-paused notice. Props only — all state and service
// calls stay in the page; this component only renders the
// toolbar with the right copy for the given state.
/** @jsxRuntime automatic */
import { Layers, Plus } from "lucide-react";
import type { BatchAction } from "../../pages/instancesLogic";

export interface BatchProgress {
  verb: string;
  done: number;
  total: number;
  current: string;
}

export interface InstancesToolbarProps {
  batchBusy: boolean;
  hasSelection: boolean;
  batchProgress: BatchProgress | null;
  pollPaused: boolean;
  onCreate: () => void;
  onOpenBatchCreate: () => void;
  onRunBatch: (action: BatchAction) => void;
  onClearSelection: () => void;
  onRetryPoll: () => void;
}

export default function InstancesToolbar({
  batchBusy,
  hasSelection,
  batchProgress,
  pollPaused,
  onCreate,
  onOpenBatchCreate,
  onRunBatch,
  onClearSelection,
  onRetryPoll,
}: InstancesToolbarProps) {
  return (
    <>
      {/* 顶部功能栏：常驻显示，按功能组整体换行。创建组
          （新建实例 / 批量创建）与批量操作组（批量启动 / 批量
          关闭 / 批量删除 / 取消选择）各自保持单行不拆分；宽度
          不足时批量操作组整体换到下一行。批量按钮只在存在
          选择时可用，不再使用勾选后弹出的批量操作栏，也不再
          单独显示选择计数。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
          <button
            type="button"
            onClick={onCreate}
            disabled={batchBusy}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-(--accent) px-3 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={14} /> 新建实例
          </button>
          <button
            type="button"
            onClick={onOpenBatchCreate}
            disabled={batchBusy}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Layers size={14} /> 批量创建
          </button>
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
          <button
            type="button"
            disabled={batchBusy || !hasSelection}
            onClick={() => onRunBatch("start")}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            批量启动
          </button>
          <button
            type="button"
            disabled={batchBusy || !hasSelection}
            onClick={() => onRunBatch("stop")}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            批量关闭
          </button>
          <button
            type="button"
            disabled={batchBusy || !hasSelection}
            onClick={() => onRunBatch("delete")}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--danger) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={batchBusy || !hasSelection}
            onClick={onClearSelection}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            取消选择
          </button>
        </div>
      </div>

      {batchProgress && (
        <p className="mt-3 shrink-0 text-xs text-(--text-dim)" role="status">
          正在批量{batchProgress.verb}：{batchProgress.done}/{batchProgress.total} · 当前 {batchProgress.current}
        </p>
      )}

      {pollPaused && (
        <p className="mt-3 shrink-0 text-xs text-(--warn)" role="status">
          自动刷新已暂停
          <button type="button" className="ml-2 underline underline-offset-2" onClick={onRetryPoll}>
            重试
          </button>
        </p>
      )}
    </>
  );
}
