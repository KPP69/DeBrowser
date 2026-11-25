// 书签资源库树：行渲染、行内按钮（折叠/编辑）、勾选与拖拽。
// 只收 props，不调用任何 Service；行数据与折叠/选择状态由页面持有。
/** @jsxRuntime automatic */
import { Bookmark, ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { VisibleRow } from "../../pages/bookmarksLogic";

export type BookmarkDropPosition = "before" | "into" | "after";

export interface BookmarkDropTarget {
  id: string;
  kind: string;
  name: string;
  parentId?: string | null;
}

export interface BookmarkTreeProps {
  rows: VisibleRow[];
  selected: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  editMode: boolean;
  busy: boolean;
  onToggleSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onEdit: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (target: BookmarkDropTarget, position: BookmarkDropPosition) => void;
}

export default function BookmarkTree({
  rows,
  selected,
  collapsed,
  editMode,
  busy,
  onToggleSelect,
  onToggleCollapse,
  onEdit,
  onDragStart,
  onDrop,
}: BookmarkTreeProps) {
  return (
    <>
      {rows.map((row) => (
        <LibraryRow
          key={row.node.id}
          row={row}
          checked={selected.has(row.node.id)}
          collapsed={collapsed.has(row.node.id)}
          editMode={editMode}
          busy={busy}
          onToggleSelect={() => onToggleSelect(row.node.id)}
          onToggleCollapse={() => onToggleCollapse(row.node.id)}
          onEdit={() => onEdit(row.node.id)}
          onDragStart={() => onDragStart(row.node.id)}
          onDrop={(pos) => onDrop(row.node, pos)}
        />
      ))}
    </>
  );
}

function LibraryRow(props: {
  row: VisibleRow;
  checked: boolean;
  collapsed: boolean;
  editMode: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onToggleCollapse: () => void;
  onEdit: () => void;
  onDragStart: () => void;
  onDrop: (pos: "before" | "into" | "after") => void;
}) {
  const { row } = props;
  const node = row.node;
  const isFolder = node.kind === "folder";
  return (
    <div
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-(--hover-bg)"
      style={{ paddingLeft: 6 + row.depth * 18 }}
      draggable
      onDragStart={props.onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / rect.height;
        props.onDrop(isFolder && ratio > 0.3 && ratio < 0.7 ? "into" : ratio <= 0.5 ? "before" : "after");
      }}
    >
      {isFolder ? (
        <button type="button" className="shrink-0 text-(--text-faint)" onClick={props.onToggleCollapse}>
          {props.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <input type="checkbox" checked={props.checked} onChange={props.onToggleSelect} />
      {isFolder ? (
        <Folder size={15} className="shrink-0 text-(--accent)" />
      ) : (
        <Bookmark size={15} className="shrink-0 text-(--text-faint)" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {node.name}
        {!isFolder && <span className="ml-2 truncate text-xs text-(--text-faint)">{node.url}</span>}
      </span>
      {props.editMode && (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-(--accent) hover:bg-(--panel-bg)"
          disabled={props.busy}
          onClick={props.onEdit}
        >
          编辑
        </button>
      )}
    </div>
  );
}
