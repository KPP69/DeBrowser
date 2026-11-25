// 书签新建/编辑弹窗：输入状态与校验归组件内部所有（名称、网址、
// 所属文件夹、当前页签、错误），父组件只传文件夹选项、busy 与
// 提交回调。Esc 关闭、输入框内 Enter 提交由 DialogLayer 提供。
// 校验：名称必填；书签的网址必填；文件夹不需要网址。提交时去首尾
// 空格；页面回调失败时错误显示在弹窗内，弹窗保持打开。
/** @jsxRuntime automatic */
import { useState } from "react";
import { DialogLayer } from "../Modal";

export type BookmarkDialogTab = "bookmark" | "folder";

export interface FolderOption {
  id: string;
  name: string;
  depth: number;
}

export interface CreateBookmarkInput {
  kind: string;
  name: string;
  url: string;
  parentId: string | null;
}

export interface UpdateBookmarkInput {
  id: string;
  name: string;
  url: string;
  parentId: string | null;
}

export interface BookmarkNodeLike {
  id: string;
  kind: string;
  name: string;
  url: string;
  parentId?: string | null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function FolderSelect(props: {
  folders: FolderOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      className="w-full rounded-md border border-(--border) bg-(--input-bg) px-2 py-1.5 text-sm"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">根目录</option>
      {props.folders.map((f) => (
        <option key={f.id} value={f.id}>
          {"　".repeat(f.depth)}
          {f.name}
        </option>
      ))}
    </select>
  );
}

export function CreateBookmarkDialog(props: {
  folders: FolderOption[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: CreateBookmarkInput) => Promise<void>;
}) {
  const [tab, setTab] = useState<BookmarkDialogTab>("bookmark");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isBookmark = tab === "bookmark";

  const submit = async () => {
    if (props.busy) return;
    if (!name.trim()) {
      setError("请填写名称。");
      return;
    }
    if (isBookmark && !url.trim()) {
      setError("请填写网址。");
      return;
    }
    setError(null);
    try {
      await props.onSubmit({
        kind: tab,
        name: name.trim(),
        url: isBookmark ? url.trim() : "",
        parentId: parentId === "" ? null : parentId,
      });
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <DialogLayer open onClose={props.onClose} onSubmit={() => void submit()}>
      <div className="w-full max-w-md rounded-lg bg-(--panel-bg) p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">新建</h3>
          <div className="ml-auto flex rounded-md bg-(--hover-bg) p-0.5">
            {(["bookmark", "folder"] as BookmarkDialogTab[]).map((t) => (
              <button
                key={t}
                type="button"
                className={
                  "rounded px-3 py-1 text-sm " + (tab === t ? "bg-(--accent) text-(--accent-contrast)" : "text-(--text-main)")
                }
                onClick={() => {
                  setTab(t);
                  setError(null);
                }}
              >
                {t === "bookmark" ? "书签" : "文件夹"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            名称
            <input
              className="rounded-md border border-(--border) bg-(--input-bg) px-2 py-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isBookmark ? "书签名称" : "文件夹名称"}
            />
          </label>
          {isBookmark && (
            <label className="flex flex-col gap-1 text-sm">
              网址
              <input
                className="rounded-md border border-(--border) bg-(--input-bg) px-2 py-1.5"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/"
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {isBookmark ? "文件夹（可选）" : "上级文件夹"}
            <FolderSelect folders={props.folders} value={parentId} onChange={setParentId} />
          </label>
          {error && <p className="text-sm text-(--danger)">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-md bg-(--hover-bg) px-3 py-1.5 text-sm" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-(--accent) px-3 py-1.5 text-sm text-(--accent-contrast) disabled:opacity-50"
            disabled={props.busy}
            onClick={() => void submit()}
          >
            保存
          </button>
        </div>
      </div>
    </DialogLayer>
  );
}

export function EditBookmarkDialog(props: {
  node: BookmarkNodeLike;
  folders: FolderOption[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: UpdateBookmarkInput) => Promise<void>;
}) {
  const [name, setName] = useState(props.node.name);
  const [url, setUrl] = useState(props.node.url);
  const [parentId, setParentId] = useState(props.node.parentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const isBookmark = props.node.kind === "bookmark";

  const submit = async () => {
    if (props.busy) return;
    if (!name.trim()) {
      setError("请填写名称。");
      return;
    }
    if (isBookmark && !url.trim()) {
      setError("请填写网址。");
      return;
    }
    setError(null);
    try {
      await props.onSubmit({
        id: props.node.id,
        name: name.trim(),
        url: isBookmark ? url.trim() : "",
        parentId: parentId === "" ? null : parentId,
      });
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <DialogLayer open onClose={props.onClose} onSubmit={() => void submit()}>
      <div className="w-full max-w-md rounded-lg bg-(--panel-bg) p-4 shadow-xl">
        <h3 className="text-base font-semibold">编辑{isBookmark ? "书签" : "文件夹"}</h3>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            名称
            <input
              className="rounded-md border border-(--border) bg-(--input-bg) px-2 py-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {isBookmark && (
            <label className="flex flex-col gap-1 text-sm">
              网址
              <input
                className="rounded-md border border-(--border) bg-(--input-bg) px-2 py-1.5"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            所属文件夹
            <FolderSelect folders={props.folders} value={parentId} onChange={setParentId} />
          </label>
          <p className="text-xs text-(--text-faint)">编辑只修改资源库，不会修改已同步到实例中的书签。</p>
          {error && <p className="text-sm text-(--danger)">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-md bg-(--hover-bg) px-3 py-1.5 text-sm" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-(--accent) px-3 py-1.5 text-sm text-(--accent-contrast) disabled:opacity-50"
            disabled={props.busy}
            onClick={() => void submit()}
          >
            保存
          </button>
        </div>
      </div>
    </DialogLayer>
  );
}
