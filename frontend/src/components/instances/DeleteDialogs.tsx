// Single-instance and batch delete confirmation dialogs for the
// instances page. Props only — all state and service calls stay in
// the page; this component only renders the two ConfirmDialogs
// with the right copy for the given targets.
/** @jsxRuntime automatic */
import { ConfirmDialog } from "../Modal";
import type { BatchPlanItem } from "../../pages/instancesLogic";
import type { Instance } from "../../../bindings/github.com/KPP69/DeBrowser/internal/model";

export interface DeleteDialogsProps {
  pendingDelete: { instance: Instance; withProfile: boolean } | null;
  onToggleWithProfile: () => void;
  onConfirmSingle: () => void;
  onCancelSingle: () => void;
  busy: boolean;
  batchDeletePlan: BatchPlanItem[] | null;
  onConfirmBatch: (plan: BatchPlanItem[]) => void;
  onCancelBatch: () => void;
  batchBusy: boolean;
}

export default function DeleteDialogs({
  pendingDelete,
  onToggleWithProfile,
  onConfirmSingle,
  onCancelSingle,
  busy,
  batchDeletePlan,
  onConfirmBatch,
  onCancelBatch,
  batchBusy,
}: DeleteDialogsProps) {
  const batchDeleteRunnable = batchDeletePlan?.filter((p) => p.run) ?? [];
  const batchDeleteSkipped = batchDeletePlan?.filter((p) => !p.run) ?? [];
  return (
    <>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `删除实例「${pendingDelete.instance.name}」` : "删除实例"}
        impact={
          pendingDelete?.withProfile
            ? `将同时删除实例记录和实例文件 ${pendingDelete.instance.userDataDir} 中的全部浏览器数据（Cookie、登录状态、历史记录等），此操作不可恢复。`
            : `仅删除实例记录，实例文件 ${pendingDelete?.instance.userDataDir ?? ""} 会保留在磁盘上，之后可以重新绑定到其他实例。`
        }
        count={1}
        countLabel="个实例"
        details={
          pendingDelete && !pendingDelete.withProfile ? (
            <button
              type="button"
              disabled={busy}
              onClick={onToggleWithProfile}
              className="mt-3 text-sm text-(--danger) underline underline-offset-2"
            >
              改为同时删除实例文件
            </button>
          ) : undefined
        }
        confirmLabel={pendingDelete?.withProfile ? "确认删除实例及实例文件" : "确认仅删除实例"}
        busy={busy}
        onConfirm={onConfirmSingle}
        onCancel={onCancelSingle}
      />

      <ConfirmDialog
        open={batchDeletePlan !== null}
        title="批量删除实例"
        impact="仅删除实例记录；实例文件会保留在磁盘上，之后可以重新绑定到其他实例。"
        count={batchDeleteRunnable.length}
        countLabel="个实例"
        details={
          <div className="mt-3 max-h-48 overflow-y-auto rounded-md border border-(--border) px-3 py-2">
            {batchDeleteRunnable.map((p) => (
              <p key={p.id} className="py-0.5 text-sm text-(--text-main)">
                {p.name}
              </p>
            ))}
          </div>
        }
        note={
          batchDeleteSkipped.length > 0
            ? `另有 ${batchDeleteSkipped.length} 个所选实例不会删除：${batchDeleteSkipped
                .map((p) => `「${p.name}」${p.reason}`)
                .join("；")}。`
            : undefined
        }
        confirmLabel={`确认删除 ${batchDeleteRunnable.length} 个实例`}
        busy={batchBusy}
        onConfirm={() => {
          if (!batchDeletePlan) return;
          onConfirmBatch(batchDeletePlan);
        }}
        onCancel={onCancelBatch}
      />
    </>
  );
}
