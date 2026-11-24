// Instance list area for the instances page: loading, load-error
// and empty states plus the instance table. Stateless — all data
// and callbacks come in as props; the page keeps selection,
// actions and loading orchestration. The proxy column reads the
// BindingView's own nodeName/sourceName.
/** @jsxRuntime automatic */
import { AppWindow, Pencil, Play, Square, Trash2 } from "lucide-react";
import { ACTIVE_STATUSES, STATUS_LABEL } from "../../pages/instancesLogic";
import type { Instance } from "../../../bindings/github.com/KPP69/DeBrowser/internal/model";
import type { BindingView } from "../../../bindings/github.com/KPP69/DeBrowser/internal/service";

// Three statuses get a small colored dot plus matching text
// color, using the shared theme tokens (gray / ok-green /
// danger-red, each already low-saturation per theme). All other
// statuses keep the neutral badge rendering.
const STATUS_DOT: Record<string, { dot: string; text: string }> = {
  stopped: { dot: "bg-(--text-dim)", text: "text-(--text-dim)" },
  running: { dot: "bg-(--ok)", text: "text-(--ok)" },
  unknown: { dot: "bg-(--danger)", text: "text-(--danger)" },
};

export interface InstanceTableProps {
  instances: Instance[];
  displayInstances: Instance[];
  loading: boolean;
  instancesError: string | null;
  onRetryLoad: () => void;
  selectedIds: ReadonlySet<string>;
  allSelected: boolean;
  batchBusy: boolean;
  browsersLoaded: boolean;
  actingId: string | null;
  proxyBindings: BindingView[];
  onToggleSelected: (id: string, checked: boolean) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onRunAction: (inst: Instance, kind: "start" | "stop") => void | Promise<void>;
  onEdit: (inst: Instance) => void;
  onDelete: (inst: Instance) => void;
}

export default function InstanceTable({
  instances,
  displayInstances,
  loading,
  instancesError,
  onRetryLoad,
  selectedIds,
  allSelected,
  batchBusy,
  browsersLoaded,
  actingId,
  proxyBindings,
  onToggleSelected,
  onToggleSelectAll,
  onRunAction,
  onEdit,
  onDelete,
}: InstanceTableProps) {
  return (
    <div className="mt-5 min-h-0 flex-1 overflow-y-auto rounded-lg border border-(--border) bg-(--panel-bg)">
      {loading ? (
        <p className="px-4 py-10 text-center text-sm text-(--text-faint)">加载中…</p>
      ) : instancesError && instances.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-12 text-center">
          <p className="text-sm text-(--danger)">实例列表加载失败：{instancesError}</p>
          <button
            type="button"
            onClick={onRetryLoad}
            className="mt-3 rounded-md border border-(--border-strong) bg-(--input-bg) px-3 py-1.5 text-sm text-(--text-main) hover:bg-(--hover-bg)"
          >
            重新加载
          </button>
        </div>
      ) : instances.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-(--hover-bg) text-(--text-faint)">
            <AppWindow size={22} />
          </span>
          <p className="mt-3 text-sm text-(--text-dim)">暂无浏览器实例</p>
          <p className="mt-1 text-xs text-(--text-faint)">点击上方「新建实例」创建第一个实例。</p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-(--text-faint)">
              <th className="sticky top-0 z-[1] w-10 border-b border-(--border) bg-(--panel-bg) px-2 py-2.5 text-center">
                <input
                  type="checkbox"
                  aria-label="全选"
                  className="h-4 w-4 accent-(--accent)"
                  checked={allSelected}
                  disabled={batchBusy}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && selectedIds.size > 0;
                  }}
                  onChange={(e) => onToggleSelectAll(e.target.checked)}
                />
              </th>
              <th className="sticky top-0 z-[1] border-b border-(--border) bg-(--panel-bg) px-4 py-2.5 font-medium">实例名称</th>
              <th className="sticky top-0 z-[1] border-b border-(--border) bg-(--panel-bg) px-4 py-2.5 text-center font-medium">代理节点</th>
              <th className="sticky top-0 z-[1] border-b border-(--border) bg-(--panel-bg) px-4 py-2.5 text-center font-medium">实例内核</th>
              <th className="sticky top-0 z-[1] border-b border-(--border) bg-(--panel-bg) px-4 py-2.5 text-center font-medium">状态</th>
              <th className="sticky top-0 z-[1] border-b border-(--border) bg-(--panel-bg) px-4 py-2.5 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {displayInstances.map((inst) => {
              const active = ACTIVE_STATUSES.has(inst.status);
              const transitioning = inst.status === "starting" || inst.status === "stopping";
              return (
                <tr key={inst.id} className="border-b border-(--border) last:border-0 hover:bg-(--hover-bg)">
                  <td className="px-2 py-2.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`选择实例 ${inst.name}`}
                      className="h-4 w-4 accent-(--accent)"
                      checked={selectedIds.has(inst.id)}
                      disabled={batchBusy}
                      onChange={(e) => onToggleSelected(inst.id, e.target.checked)}
                    />
                  </td>
                  <td className="px-4 py-2.5 font-medium">{inst.name}</td>
                  <td className="px-4 py-2.5 text-center text-(--text-dim)">
                    {(() => {
                      const b = proxyBindings.find((x) => x.instanceId === inst.id);
                      return b ? `${b.nodeName}（${b.sourceName}）` : "未设置";
                    })()}
                  </td>
                  <td className="px-4 py-2.5 text-center text-(--text-dim)">
                    <span title={inst.kernelExecutablePath || undefined}>
                      {inst.kernelName
                        ? `${inst.kernelName}${inst.kernelVersion ? ` ${inst.kernelVersion}` : ""}`
                        : "未指定"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {STATUS_DOT[inst.status] ? (
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs ${STATUS_DOT[inst.status].text}`}
                      >
                        <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${STATUS_DOT[inst.status].dot}`} />
                        {STATUS_LABEL[inst.status]}
                      </span>
                    ) : (
                      <span className="rounded-full bg-(--badge-bg) px-2 py-0.5 text-xs text-(--text-dim)">
                        {STATUS_LABEL[inst.status] ?? inst.status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-center gap-1">
                      {inst.status === "running" || inst.status === "stopping" ? (
                        <button
                          type="button"
                          title="关闭"
                          disabled={batchBusy || transitioning || actingId === inst.id || inst.status === "stopping"}
                          onClick={() => void onRunAction(inst, "stop")}
                          className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-(--text-dim) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Square size={13} /> 关闭
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="启动"
                          disabled={batchBusy || active || transitioning || actingId === inst.id}
                          onClick={() => void onRunAction(inst, "start")}
                          className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-(--text-dim) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Play size={13} /> 启动
                        </button>
                      )}
                      <button
                        type="button"
                        title={browsersLoaded ? "编辑" : "内核列表加载完成后可编辑"}
                        disabled={batchBusy || !browsersLoaded || transitioning}
                        className="rounded p-1.5 text-(--text-dim) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => onEdit(inst)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        title={active ? "实例运行期间不能删除" : "删除实例"}
                        disabled={batchBusy || active}
                        onClick={() => onDelete(inst)}
                        className="rounded p-1.5 text-(--text-dim) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
