// Batch-create dialog for the instances page. Props only — the
// page keeps the batch state and the submit orchestration; this
// component only renders the form (prefix, count, kernel) with
// its live name preview.
/** @jsxRuntime automatic */
import { Dialog } from "../Modal";
import { inputCls, labelCls } from "./formStyles";

export interface BatchCreateState {
  prefix: string;
  count: string;
  browserId: string;
}

export interface BatchCreateDialogProps {
  batchCreate: BatchCreateState | null;
  onChange: (next: BatchCreateState) => void;
  kernelOptions: { id: string; label: string }[];
  browsersLoaded: boolean;
  busy: boolean;
  error: string | null;
  maxCount: number;
  onClose: () => void;
  // onCancel is the footer 取消 button: unlike onClose (Esc /
  // backdrop, blocked while busy), the original dialog let the
  // footer button close unconditionally.
  onCancel: () => void;
  onSubmit: () => void;
}

export default function BatchCreateDialog({
  batchCreate,
  onChange,
  kernelOptions,
  browsersLoaded,
  busy,
  error,
  maxCount,
  onClose,
  onCancel,
  onSubmit,
}: BatchCreateDialogProps) {
  if (!batchCreate) return null;
  return (
    <Dialog open onClose={onClose} onSubmit={onSubmit}>
      <h3 className="text-base font-semibold">批量创建实例</h3>
      <div className="mt-4 space-y-3">
        <div>
          <label className={labelCls}>实例名称前缀（必填）</label>
          <input
            className={inputCls}
            value={batchCreate.prefix}
            onChange={(e) => onChange({ ...batchCreate, prefix: e.target.value })}
            placeholder="例如：测试浏览器"
          />
        </div>
        <div>
          <label className={labelCls}>创建数量（必填，一次最多 {maxCount} 个）</label>
          <input
            className={inputCls}
            type="number"
            min={1}
            max={maxCount}
            step={1}
            value={batchCreate.count}
            onChange={(e) => onChange({ ...batchCreate, count: e.target.value })}
          />
          {batchCreate.prefix.trim() !== "" &&
            Number.isInteger(Number(batchCreate.count)) &&
            Number(batchCreate.count) >= 1 &&
            Number(batchCreate.count) <= maxCount && (
              <p className="mt-1 text-xs text-(--text-faint)">
                将创建：{batchCreate.prefix.trim()}1、{batchCreate.prefix.trim()}2
                {Number(batchCreate.count) > 2 && ` …… ${batchCreate.prefix.trim()}${Number(batchCreate.count)}`}
                （共 {Number(batchCreate.count)} 个），每个实例自动分配独立的实例文件。
              </p>
            )}
        </div>
        <div>
          <label className={labelCls}>实例内核（必选）</label>
          <select
            className={inputCls}
            value={batchCreate.browserId}
            disabled={!browsersLoaded}
            onChange={(e) => onChange({ ...batchCreate, browserId: e.target.value })}
          >
            <option value="">请选择内核</option>
            {kernelOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          {!browsersLoaded && <p className="mt-1 text-xs text-(--text-faint)">内核列表加载中…</p>}
          {browsersLoaded && kernelOptions.length === 0 && (
            <p className="mt-1 text-xs text-(--text-faint)">尚未登记任何浏览器内核，请先在「浏览器内核」页面添加。</p>
          )}
        </div>
        {error && <p className="text-sm text-(--danger)">{error}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-(--border) px-3 py-1.5 text-sm text-(--text-dim) hover:bg-(--hover-bg)"
        >
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSubmit}
          className="rounded-md bg-(--accent) px-3 py-1.5 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:opacity-50"
        >
          创建
        </button>
      </div>
    </Dialog>
  );
}
