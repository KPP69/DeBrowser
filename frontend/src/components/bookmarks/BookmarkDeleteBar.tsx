// 书签删除按钮组：未确认时显示「删除所选」，确认后显示影响
// 文案与「确定删除 / 取消」。只收 props，不调用任何 Service；
// 删除数量与文件夹影响由页面用 bookmarksLogic.selectionScope
// 算好后传入（folderCount > 0 时提示文件夹内容将一并删除）。
/** @jsxRuntime automatic */
import { Trash2 } from "lucide-react";

export interface BookmarkDeleteBarProps {
  selectedCount: number;
  folderCount: number;
  busy: boolean;
  armed: boolean;
  onArm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function BookmarkDeleteBar({
  selectedCount,
  folderCount,
  busy,
  armed,
  onArm,
  onConfirm,
  onCancel,
}: BookmarkDeleteBarProps) {
  if (!armed) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 rounded-md bg-(--hover-bg) px-3 py-1.5 text-sm text-(--text-main) disabled:opacity-50"
        disabled={busy || selectedCount === 0}
        onClick={onArm}
      >
        <Trash2 size={15} /> 删除所选
      </button>
    );
  }
  return (
    <>
      {folderCount > 0 && (
        <span className="text-xs text-(--danger)">所选包含文件夹，其内容将一并删除</span>
      )}
      <button
        type="button"
        className="flex items-center gap-1 rounded-md bg-(--danger) px-3 py-1.5 text-sm text-(--danger-contrast) disabled:opacity-50"
        disabled={busy}
        onClick={onConfirm}
      >
        确定删除
      </button>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md bg-(--hover-bg) px-3 py-1.5 text-sm text-(--text-main) disabled:opacity-50"
        disabled={busy}
        onClick={onCancel}
      >
        取消
      </button>
    </>
  );
}
