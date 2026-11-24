// 同步前确认弹窗：检测到运行中实例时先确认关闭，关闭中显示等待态。
// 只收 props，不调用任何 Service；closeInstancesThenSync 留在页面，
// 通过 onConfirm 传入；关闭处理中不允许取消，由页面 onClose 把关。
/** @jsxRuntime automatic */
import { Loader2 } from "lucide-react";
import { DialogLayer } from "../Modal";

export type SyncGateState = "confirm" | "closing";

export interface SyncGateDialogProps {
  gate: SyncGateState;
  // 由页面传入（与其它书签组件保持一致的 props 形状）；弹窗的
  // 两态由 gate 决定，与原页面行为一致，故此处不另作禁用。
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function SyncGateDialog({
  gate,
  onClose,
  onConfirm,
}: SyncGateDialogProps) {
  return (
    <DialogLayer open onClose={onClose}>
      <div className="w-full max-w-md rounded-lg bg-(--panel-bg) p-4 shadow-xl">
        <h3 className="text-base font-semibold">同步前关闭实例</h3>
        {gate === "closing" ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-(--text-dim)">
            <Loader2 size={15} className="animate-spin" /> 正在关闭浏览器实例，请稍候……
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-(--text-dim)">
              检测到仍有浏览器实例正在运行，书签同步前需要先关闭所有浏览器实例。
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                className="rounded-md bg-(--accent) px-3 py-1.5 text-sm text-(--accent-contrast)"
                onClick={onConfirm}
              >
                关闭实例
              </button>
              <button
                type="button"
                className="rounded-md bg-(--hover-bg) px-3 py-1.5 text-sm"
                onClick={onClose}
              >
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </DialogLayer>
  );
}
