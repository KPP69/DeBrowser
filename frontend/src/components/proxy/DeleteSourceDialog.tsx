// 删除代理来源确认弹窗：只收 props，不调用任何 Service；
// 确认后把来源交回页面删除（删除本身由页面编排）。
/** @jsxRuntime automatic */
import { ConfirmDialog } from "../Modal";
import type { SourceView } from "../../../bindings/github.com/KPP69/DeBrowser/internal/service";

export interface DeleteSourceDialogProps {
  source: SourceView | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (source: SourceView) => void;
}

export default function DeleteSourceDialog({ source, busy, onCancel, onConfirm }: DeleteSourceDialogProps) {
  return (
    <ConfirmDialog
      open={source !== null}
      title={source ? `删除代理配置「${source.name}」` : "删除代理配置"}
      impact="其全部节点将被移除，正在使用这些节点的实例将变为未设置代理。此操作不可恢复。"
      count={1}
      countLabel="个代理配置"
      confirmLabel="删除"
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        if (!source) return;
        onConfirm(source);
      }}
    />
  );
}
