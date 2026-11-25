import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import {
  BookmarkService,
  InstanceService,
  type BookmarkInstanceInfo,
} from "../../bindings/github.com/KPP69/DeBrowser/internal/service";
import type { BookmarkNode } from "../../bindings/github.com/KPP69/DeBrowser/internal/model";
import { newOperationId, recordOperationFeedback } from "../lib/operations";
import { notifyError, notifySuccess, notifyWarning } from "../stores/useNotificationStore";
import {
  buildTree,
  folderOptions,
  searchVisibleIds,
  notStoppedCount,
  selectionScope,
  siblingIds,
  syncEntryDecision,
  visibleRows,
} from "./bookmarksLogic";
import SyncDialog from "./BookmarksPageSync";
import BookmarkTree from "../components/bookmarks/BookmarkTree";
import { CreateBookmarkDialog, EditBookmarkDialog } from "../components/bookmarks/BookmarkDialogs";
import BookmarksToolbar from "../components/bookmarks/BookmarksToolbar";
import BookmarkInstanceList from "../components/bookmarks/BookmarkInstanceList";
import SyncGateDialog from "../components/bookmarks/SyncGateDialog";
import { usePageRefresh } from "../hooks/usePageRefresh";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 书签管理：左侧是 DeBrowser 自己的书签资源库（数据库），右侧是
// 实例列表（仅名称、书签数量与选择框）。资源库与各实例 Profile
// 中的真实书签完全独立：编辑/删除资源库不影响实例，同步弹窗中
// 对实例书签的编辑/删除也不回写资源库。实例书签只通过同步弹窗
// 操作，且只作用于已确认停止的实例（运行中或状态无法确认的
// 实例会被跳过并明确反馈），详见后端 BookmarkService。
export default function BookmarksPage() {
  const [nodes, setNodes] = useState<BookmarkNode[]>([]);
  const [instances, setInstances] = useState<BookmarkInstanceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [libQuery, setLibQuery] = useState("");
  const [editMode, setEditMode] = useState(false);

  const [instQuery, setInstQuery] = useState("");
  const [instSelected, setInstSelected] = useState<ReadonlySet<string>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [editNode, setEditNode] = useState<BookmarkNode | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  // 同步入口状态：idle 无窗口；confirm 显示「关闭实例」确认窗口；
  // closing 正在关闭全部运行中实例并等待确认停止。
  const [syncGate, setSyncGate] = useState<"idle" | "confirm" | "closing">("idle");
  const closingRef = useRef(false);

  const [dragId, setDragId] = useState<string | null>(null);

  // 查询全部实例的后端书签访问门禁结果（InstanceBookmarkAccess）。
  // 是否「确认停止」以后端门禁为唯一依据：error 等状态只有后端
  // 结合运行时记录才能判定，前端不凭实例状态字符串自行判断。
  // 单个查询失败按 unknown 处理，绝不默认放行。
  const collectBookmarkGates = async (): Promise<string[]> => {
    const list = (await InstanceService.ListInstances()) ?? [];
    const gates = await Promise.all(
      list.map(async (inst) => {
        try {
          const [, , gate] = await InstanceService.InstanceBookmarkAccess(inst.id);
          return gate;
        } catch {
          return "unknown";
        }
      }),
    );
    return gates;
  };

  // 点击「同步」：先用后端门禁检查全部实例。全部确认停止才直接
  // 打开同步弹窗；存在运行中实例时先弹确认窗口；只有状态无法
  // 确认的实例时关闭也无济于事，直接提示。
  const handleSyncClick = async () => {
    setBusy("sync-check");
    try {
      const gates = await collectBookmarkGates();
      const decision = syncEntryDecision(gates);
      if (decision === "open") {
        setSyncOpen(true);
      } else if (decision === "confirm") {
        setSyncGate("confirm");
      } else {
        notifyError(
          "有 " + notStoppedCount(gates) + " 个浏览器实例的状态无法确认停止，无法打开书签同步。请先在浏览器实例页面处理后再试。",
          { important: true },
        );
      }
    } catch (err) {
      notifyError("检查浏览器实例状态失败：" + errText(err), { important: true });
    } finally {
      setBusy(null);
    }
  };

  // 确认窗口的「关闭实例」：对运行中（含关闭中）的实例并行调用
  // 既有正常关闭服务，互不取消；全部关闭调用返回后，再统一用
  // 后端门禁复查全部实例。只有全部确认停止才打开同步弹窗；任何
  // 实例关闭失败或仍无法确认停止都不打开弹窗、不修改任何书签，
  // 用户可自行处理后重新点击同步重试。
  const closeInstancesThenSync = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setSyncGate("closing");
    try {
      const opId = newOperationId();
      const list = (await InstanceService.ListInstances()) ?? [];
      const toStop = list.filter((i) => i.status === "running" || i.status === "stopping");
      await Promise.allSettled(
        toStop.map((inst) => InstanceService.StopInstance(opId, inst.id)),
      );
      const gates = await collectBookmarkGates();
      if (gates.every((g) => g === "stopped")) {
        setSyncGate("idle");
        setSyncOpen(true);
        void reload();
      } else {
        setSyncGate("idle");
        notifyError(
          "仍有 " + notStoppedCount(gates) + " 个浏览器实例未能关闭或无法确认停止，无法打开书签同步。",
          { important: true },
        );
      }
    } catch (err) {
      setSyncGate("idle");
      notifyError("关闭浏览器实例失败：" + errText(err), { important: true });
    } finally {
      closingRef.current = false;
    }
  };

  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  // reload 刷新资源库与实例列表。失败时默认发一条刷新失败
  // 警告；调用方需要区分语义时（首次加载、删除后刷新）传入
  // onFail 自定义提示。返回是否成功。
  const reload = useCallback(async (onFail?: (message: string) => void): Promise<boolean> => {
    try {
      const [lib, inst] = await Promise.all([
        BookmarkService.ListLibrary(),
        BookmarkService.ListBookmarkInstances(),
      ]);
      setNodes(lib ?? []);
      setInstances(inst ?? []);
      loadedRef.current = true;
      setLoadError(null);
      return true;
    } catch (e) {
      const message = errText(e);
      if (!loadedRef.current) setLoadError(message);
      if (onFail) onFail(message);
      else notifyWarning("列表刷新失败，请重新搜索。");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // 已访问页面保持挂载，其他页面刚改过的数据不会自己刷新：
  // 每次回到本页时静默重载一次（首次挂载由原有加载逻辑负责）。
  usePageRefresh("bookmarks", reload);


  useEffect(() => {
    void reload((message) => notifyError("加载书签失败：" + message));
  }, [reload]);

  const run = async (
    key: string,
    action: string,
    fn: (opId: string) => Promise<string | void>,
  ) => {
    setBusy(key);
    const opId = newOperationId();
    try {
      const feedback = await fn(opId);
      if (feedback) {
        notifySuccess(feedback, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, feedback, "书签管理", action);
      }
    } catch (e) {
      const message = errText(e);
      notifyError(message, { operationId: opId, important: true });
      recordOperationFeedback(opId, false, message, "书签管理", action);
    } finally {
      setBusy(null);
    }
  };

  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const searchSet = useMemo(() => searchVisibleIds(nodes, libQuery), [nodes, libQuery]);
  const rows = useMemo(() => {
    const all = visibleRows(tree, searchSet ? new Set<string>() : collapsed);
    return searchSet ? all.filter((r) => searchSet.has(r.node.id)) : all;
  }, [tree, collapsed, searchSet]);
  const scope = useMemo(() => selectionScope(nodes, selected), [nodes, selected]);
  const folders = useMemo(() => folderOptions(nodes), [nodes]);

  const filteredInstances = useMemo(() => {
    const q = instQuery.trim().toLowerCase();
    return q ? instances.filter((i) => i.name.toLowerCase().includes(q)) : instances;
  }, [instances, instQuery]);

  const toggleSelect = (id: string) => {
    // 选择变化后退出删除确认状态，避免确认的集合与实际
    // 执行删除的集合不一致。
    setDeleteArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleInstSelect = (id: string) => {
    setInstSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleInstSelectAll = (checked: boolean) => {
    setInstSelected((prev) => {
      const next = new Set(prev);
      for (const i of filteredInstances) {
        if (checked) next.add(i.id);
        else next.delete(i.id);
      }
      return next;
    });
  };

  // ---- drag & drop: reorder within a level, or move into a folder ----
  const onDropRow = async (
    target: { id: string; kind: string; name: string; parentId?: string | null },
    position: "before" | "into" | "after",
  ) => {
    const dragged = nodes.find((n) => n.id === dragId);
    setDragId(null);
    if (!dragged || dragged.id === target.id) return;
    await run("drag", "拖动调整", async (opId) => {
      if (position === "into" && target.kind === "folder") {
        await BookmarkService.UpdateLibraryNode(opId, {
          id: dragged.id,
          name: dragged.name,
          url: dragged.url,
          parentId: target.id,
        });
        await reload();
        return "已移动到文件夹「" + target.name + "」";
      }
      const parentId = target.parentId ?? null;
      const ids = siblingIds(nodes, parentId).filter((id) => id !== dragged.id);
      const at = ids.indexOf(target.id);
      ids.splice(position === "after" ? at + 1 : at, 0, dragged.id);
      if ((dragged.parentId ?? null) !== parentId) {
        await BookmarkService.UpdateLibraryNode(opId, {
          id: dragged.id,
          name: dragged.name,
          url: dragged.url,
          parentId,
        });
      }
      await BookmarkService.ReorderLibrary(opId, parentId, ids);
      await reload();
      return "顺序已更新";
    });
  };

  const doDelete = async () => {
    await run("delete", "删除书签资源", async (opId) => {
      const count = await BookmarkService.DeleteLibraryNodes(opId, [...selected]);
      // 删除成功即为最终结果：清空选择、退出确认状态，
      // 随后保留原搜索条件重新查询。刷新失败只单独提示
      // （仅通知台），不影响删除成功的通知与日志记录。
      setSelected(new Set());
      setDeleteArmed(false);
      await reload(() => notifyWarning("删除已完成，但列表刷新失败，请重新搜索。"));
      return "已删除 " + count + " 项";
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* 顶部工具栏 */}
      <BookmarksToolbar
        editMode={editMode}
        busy={busy !== null}
        selectedCount={selected.size}
        scope={scope}
        deleteArmed={deleteArmed}
        onNew={() => setCreateOpen(true)}
        onToggleEditMode={() => setEditMode((v) => !v)}
        onArmDelete={() => setDeleteArmed(true)}
        onConfirmDelete={() => void doDelete()}
        onCancelDelete={() => setDeleteArmed(false)}
        onSyncClick={() => void handleSyncClick()}
      />

      {/* 主体：左右两区独立滚动 */}
      <div className="flex min-h-0 flex-1 gap-3">
        <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-(--border) bg-(--panel-bg)">
          <header className="flex items-center gap-2 border-b border-(--border) px-3 py-2">
            <h3 className="text-sm font-semibold">书签列表</h3>
            <label className="ml-auto flex items-center gap-1 rounded-md bg-(--hover-bg) px-2 py-1">
              <Search size={13} className="text-(--text-faint)" />
              <input
                className="w-36 bg-transparent text-xs outline-none"
                placeholder="搜索书签"
                value={libQuery}
                onChange={(e) => setLibQuery(e.target.value)}
              />
            </label>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {loading ? (
              <p className="flex items-center gap-2 px-3 py-4 text-sm text-(--text-faint)">
                <Loader2 size={14} className="animate-spin" /> 正在加载…
              </p>
            ) : loadError && nodes.length === 0 ? (
              <div className="px-3 py-4">
                <p className="text-sm text-(--danger)">书签加载失败：{loadError}</p>
                <button
                  type="button"
                  className="mt-2 rounded-md border border-(--border-strong) bg-(--input-bg) px-3 py-1.5 text-sm text-(--text-main) hover:bg-(--hover-bg)"
                  onClick={() => void reload((message) => notifyError("加载书签失败：" + message))}
                >
                  重新加载
                </button>
              </div>
            ) : rows.length === 0 ? (
              <p className="px-3 py-4 text-sm text-(--text-faint)">
                {nodes.length === 0 ? "资源库为空，点击「新建」添加书签或文件夹。" : "没有匹配的书签。"}
              </p>
            ) : (
              <BookmarkTree
                rows={rows}
                selected={selected}
                collapsed={collapsed}
                editMode={editMode}
                busy={busy !== null}
                onToggleSelect={toggleSelect}
                onToggleCollapse={toggleCollapse}
                onEdit={(id) => {
                  const full = nodes.find((n) => n.id === id);
                  if (full) setEditNode(full);
                }}
                onDragStart={setDragId}
                onDrop={(target, pos) => void onDropRow(target, pos)}
              />
            )}
          </div>
        </section>

        <BookmarkInstanceList
          filteredInstances={filteredInstances}
          instSelected={instSelected}
          instQuery={instQuery}
          busy={busy !== null}
          onInstQueryChange={setInstQuery}
          onToggleInstSelect={toggleInstSelect}
          onToggleInstSelectAll={toggleInstSelectAll}
        />
      </div>

      {createOpen && (
        <CreateBookmarkDialog
          folders={folders}
          busy={busy !== null}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (input) => {
            await run("create", "新建书签资源", async (opId) => {
              await BookmarkService.CreateLibraryNode(opId, input);
              setCreateOpen(false);
              await reload();
              return input.kind === "folder" ? "文件夹已创建" : "书签已创建";
            });
          }}
        />
      )}

      {editNode && (
        <EditBookmarkDialog
          node={editNode}
          folders={folders.filter((f) => f.id !== editNode.id)}
          busy={busy !== null}
          onClose={() => setEditNode(null)}
          onSubmit={async (input) => {
            await run("edit", "编辑书签资源", async (opId) => {
              await BookmarkService.UpdateLibraryNode(opId, input);
              setEditNode(null);
              await reload();
              return "已保存";
            });
          }}
        />
      )}

      {syncGate !== "idle" && (
        <SyncGateDialog
          gate={syncGate}
          busy={busy !== null}
          onClose={() => {
            // 关闭处理中不允许取消。
            if (syncGate === "confirm") setSyncGate("idle");
          }}
          onConfirm={() => void closeInstancesThenSync()}
        />
      )}

      {syncOpen && (
        <SyncDialog
          nodes={nodes}
          instances={instances}
          onClose={() => {
            setSyncOpen(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
