// 书签页顶部工具栏：新建/编辑按钮、删除按钮组、同步按钮与右侧说明。
// 只收 props，不调用任何 Service；删除与同步的编排函数留在页面。
/** @jsxRuntime automatic */
import { Pencil, Plus, Send } from "lucide-react";
import type { SelectionScope } from "../../pages/bookmarksLogic";
import BookmarkDeleteBar from "./BookmarkDeleteBar";

export interface BookmarksToolbarProps {
  editMode: boolean;
  busy: boolean;
  selectedCount: number;
  scope: SelectionScope;
  deleteArmed: boolean;
  onNew: () => void;
  onToggleEditMode: () => void;
  onArmDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onSyncClick: () => void;
}

export default function BookmarksToolbar({
  editMode,
  busy,
  selectedCount,
  scope,
  deleteArmed,
  onNew,
  onToggleEditMode,
  onArmDelete,
  onConfirmDelete,
  onCancelDelete,
  onSyncClick,
}: BookmarksToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="flex items-center gap-1 rounded-md bg-(--accent) px-3 py-1.5 text-sm text-(--accent-contrast) disabled:opacity-50"
        disabled={busy}
        onClick={onNew}
      >
        <Plus size={15} /> 新建
      </button>
      <button
        type="button"
        className={
          "flex items-center gap-1 rounded-md px-3 py-1.5 text-sm disabled:opacity-50 " +
          (editMode ? "bg-(--accent) text-(--accent-contrast)" : "bg-(--hover-bg) text-(--text-main)")
        }
        disabled={busy}
        onClick={onToggleEditMode}
      >
        <Pencil size={15} /> 编辑
      </button>
      <BookmarkDeleteBar
        selectedCount={selectedCount}
        folderCount={scope.folders}
        busy={busy}
        armed={deleteArmed}
        onArm={onArmDelete}
        onConfirm={onConfirmDelete}
        onCancel={onCancelDelete}
      />
      <button
        type="button"
        className="flex items-center gap-1 rounded-md bg-(--hover-bg) px-3 py-1.5 text-sm text-(--text-main) disabled:opacity-50"
        disabled={busy}
        onClick={onSyncClick}
      >
        <Send size={15} /> 同步
      </button>
      <span className="ml-auto text-xs text-(--text-faint)">
        资源库与实例书签相互独立，互不自动覆盖
      </span>
    </div>
  );
}
