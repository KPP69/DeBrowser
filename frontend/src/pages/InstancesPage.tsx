import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Layers,
  Plus,
  TriangleAlert,
} from "lucide-react";
import {
  BrowserService,
  InstanceService,
  ProxyService,
  type BindingView,
  type BrowserView,
  type NodeView,
} from "../../bindings/github.com/KPP69/DeBrowser/internal/service";
import type { Instance } from "../../bindings/github.com/KPP69/DeBrowser/internal/model";
import { useAppStore } from "../stores/useAppStore";
import { notify, notifyError, notifySuccess } from "../stores/useNotificationStore";
import { classifyCounts } from "../lib/operationResult";
import type { NotificationItem } from "../lib/notifications";
import { newOperationId, recordOperationFeedback } from "../lib/operations";
import {
  kernelOptionLabels,
  planBatch,
  planBatchCreate,
  profileFolderOf,
  pruneSelection,
  sortInstancesByName,
  MAX_BATCH_CREATE,
  type BatchAction,
  type BatchPlanItem,
} from "./instancesLogic";
import DeleteDialogs from "../components/instances/DeleteDialogs";
import BatchCreateDialog, { type BatchCreateState } from "../components/instances/BatchCreateDialog";
import InstanceTable from "../components/instances/InstanceTable";
import ProfilePickerDialog, { type ProfilePickerState } from "../components/instances/ProfilePickerDialog";
import InstanceFormDialog, { EMPTY_FORM, type FormState } from "../components/instances/InstanceFormDialog";

type PendingDelete = { instance: Instance; withProfile: boolean } | null;

// The outcome of one batch operation goes to the global
// notification system as ONE summary notification; the
// per-item results (succeeded / skipped with reason / failed
// with reason) ride along as expandable items in the
// notification center. Partial success is reported as partial.
function notifyBatchResult(
  title: string,
  okNames: string[],
  skipped: { name: string; reason: string }[],
  failed: { name: string; reason: string }[],
): void {
  const items: NotificationItem[] = [
    ...okNames.map((name) => ({ name, status: "success" as const })),
    ...skipped.map((it) => ({ name: it.name, status: "skipped" as const, reason: it.reason })),
    ...failed.map((it) => ({ name: it.name, status: "failed" as const, reason: it.reason })),
  ];
  const summary =
    `${title}：成功 ${okNames.length} 个` +
    (skipped.length > 0 ? `，跳过 ${skipped.length} 个` : "") +
    (failed.length > 0 ? `，失败 ${failed.length} 个` : "");
  const kind = classifyCounts(okNames.length, failed.length, skipped.length);
  if (kind !== null) notify(kind, summary, { items, important: true });
}

// The instance-file picker dialog: the options are fetched fresh
// at open time (never the form-open cache), exactly one may be
// picked, and nothing is applied until 「选择」 confirms.
const BATCH_VERB: Record<BatchAction, string> = { start: "启动", stop: "关闭", delete: "删除" };
const BATCH_OP_ACTION: Record<BatchAction, string> = {
  start: "instance.start",
  stop: "instance.stop",
  delete: "instance.delete",
};

/**
 * 浏览器实例管理（Stage 9B）：实例的新建、编辑、删除与真实运行。
 * 每个实例绑定一个独立的实例文件（data/profiles 下的文件夹），
 * 启动时以该文件夹作为浏览器的数据目录。删除分两种且含义明确
 * 区分：「仅删除实例」保留实例文件；「删除实例及其实例文件」才
 * 会删除磁盘上的浏览器数据，且必须由用户明确选择。
 *
 * 列表按实例名称自然排序显示；批量启动/关闭/删除与批量创建都
 * 逐项复用单实例操作与其安全门禁，逐项记录结果，部分失败如实
 * 汇报，不引入额外的任务调度机制。
 */
export default function InstancesPage() {
  const setPage = useAppStore((state) => state.setPage);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  // browsersLoaded is true only after ListBrowsers has succeeded.
  // While it is false (still loading, or the load failed), saving
  // is disabled: judging an association against a not-yet-loaded
  // list would mistake it for a missing registration, and saving
  // would then clear the association in the database.
  const [browsersLoaded, setBrowsersLoaded] = useState(false);
  const [browsersError, setBrowsersError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Instance | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState<FormState>(EMPTY_FORM);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  // Batch management state.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 列表请求序号：轮询与操作后刷新并发时，只接受最后发出的响应。
  const listSeq = useRef(0);
  const pollFails = useRef(0);
  // 轮询返回与上次相同的数据时跳过 setState，避免整张表每 2.5 秒
  // 无意义重渲染一次。
  const lastListJSON = useRef("");
  const lastBindingsJSON = useRef("");
  const [pollPaused, setPollPaused] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ verb: string; done: number; total: number; current: string } | null>(null);
  const [batchDeletePlan, setBatchDeletePlan] = useState<BatchPlanItem[] | null>(null);
  const [batchCreate, setBatchCreate] = useState<BatchCreateState | null>(null);
  const [batchCreateError, setBatchCreateError] = useState<string | null>(null);
  const [batchCreateBusy, setBatchCreateBusy] = useState(false);
  // Proxy binding display + form data (from the proxy module's
  // single binding relation; see FormState.proxyNodeId).
  const [proxyNodes, setProxyNodes] = useState<NodeView[]>([]);
  const [proxyBindings, setProxyBindings] = useState<BindingView[]>([]);
  // Instance-file picker state (inside the create/edit form).
  const [profilePicker, setProfilePicker] = useState<ProfilePickerState | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [appliedProfileName, setAppliedProfileName] = useState<string | null>(null);

  // The list is displayed in natural name order; selection and
  // select-all always refer to exactly this displayed list.
  const displayInstances = useMemo(() => sortInstancesByName(instances), [instances]);
  const kernelLabels = useMemo(() => kernelOptionLabels(browsers), [browsers]);

  const refreshInstances = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      const list = await InstanceService.ListInstances();
      if (seq !== listSeq.current) return;
      const nextJSON = JSON.stringify(list ?? []);
      if (nextJSON !== lastListJSON.current) {
        lastListJSON.current = nextJSON;
        setInstances(list ?? []);
      }
      pollFails.current = 0;
      setPollPaused(false);
    } catch {
      // A failed background refresh keeps the last known list;
      // after three consecutive failures polling pauses, so a
      // dead connection does not keep firing silent errors.
      pollFails.current += 1;
      if (pollFails.current >= 3) setPollPaused(true);
    }
    // Bindings changed on the proxy page show up here too:
    // both pages read the same relation.
    try {
      const bds = await ProxyService.ListBindings();
      if (seq !== listSeq.current) return;
      const bindingsJSON = JSON.stringify(bds ?? []);
      if (bindingsJSON !== lastBindingsJSON.current) {
        lastBindingsJSON.current = bindingsJSON;
        setProxyBindings(bds ?? []);
      }
    } catch {
      // Keep the last known bindings on failure.
    }
  }, []);

  const loadAll = useCallback(async (initial: boolean) => {
    // Close the editing gate FIRST, before any await: on a reload,
    // a stale browsersLoaded=true from the previous load must not
    // keep editing enabled while the fresh lists are in flight.
    // Only a successful ListBrowsers below re-opens it.
    if (initial) {
      setBrowsersLoaded(false);
      setLoading(true);
    }
    const seq = ++listSeq.current;
    try {
      const list = await InstanceService.ListInstances();
      if (seq !== listSeq.current) return;
      setInstances(list ?? []);
      setInstancesError(null);
    } catch (err) {
      // 读取失败与真实空列表严格区分：保留失败原因供页面
      // 显示加载失败状态（不伪装成暂无实例），同时发一条
      // 通知台错误。已有列表时不清空。
      const message = err instanceof Error ? err.message : String(err);
      setInstancesError(message);
      notifyError(`加载实例列表失败：${message}`);
    } finally {
      if (initial) setLoading(false);
    }
    try {
      const regs = await BrowserService.ListBrowsers();
      setBrowsers(regs ?? []);
      setBrowsersError(null);
      setBrowsersLoaded(true);
    } catch (err) {
      // A failed load is NOT "no registrations": browsersLoaded
      // stays false, editing stays disabled, and nothing about
      // existing associations is inferred or touched.
      setBrowsersError(err instanceof Error ? err.message : String(err));
    }
    // Proxy nodes + bindings for the table column and the form
    // selector. A failure here only empties the proxy display;
    // it never touches instance or kernel data.
    try {
      const [nds, bds] = await Promise.all([ProxyService.ListNodes(), ProxyService.ListBindings()]);
      setProxyNodes(nds ?? []);
      setProxyBindings(bds ?? []);
    } catch {
      // Keep the last known proxy data.
    }
  }, []);

  const load = useCallback(() => loadAll(true), [loadAll]);
  const refresh = useCallback(() => loadAll(false), [loadAll]);
  // 已访问页面保持挂载，其他页面刚改过的数据不会自己刷新：
  // 每次回到本页时静默重载一次（首次挂载由原有加载逻辑负责）。
  const appPage = useAppStore((state) => state.page);
  const firstActivation = useRef(true);
  useEffect(() => {
    if (firstActivation.current) {
      firstActivation.current = false;
      return;
    }
    if (appPage === "instances") void refresh();
  }, [appPage, refresh]);


  useEffect(() => {
    void load();
  }, [load]);

  // Keep run states fresh while the page is open (a browser the
  // user closed directly must flip to 已关闭 without a reload).
  useEffect(() => {
    if (pollPaused || appPage !== "instances") return;
    const timer = setInterval(() => void refreshInstances(), 2500);
    return () => clearInterval(timer);
  }, [refreshInstances, pollPaused, appPage]);

  // Selection never outlives the displayed list: ids that vanish
  // (deleted instances, reloads) are dropped from the selection.
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = pruneSelection(
        prev,
        instances.map((i) => i.id),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [instances]);

  const openCreate = () => {
    setEditing(null);
    setFormInitial(EMPTY_FORM);
    setFormOpen(true);
    setProfileNote(null);
  };

  const openEdit = (inst: Instance) => {
    setEditing(inst);
    setFormInitial({
      id: inst.id,
      name: inst.name,
      // A kernelId that no longer resolves to a registration is
      // shown as unassociated (see the note in the form); saving
      // then clears it.
      browserId: browsers.some((b) => b.id === inst.kernelId) ? inst.kernelId : "",
      profileMode: "rename",
      profileName: profileFolderOf(inst),
      // The current binding from the shared relation; a binding
      // whose node has vanished cannot occur (the database
      // cascades), so a missing entry simply means unbound.
      proxyNodeId: proxyBindings.find((b) => b.instanceId === inst.id)?.nodeId ?? "",
    });
    setFormOpen(true);
    setProfileNote(null);
  };

  const handleFormSubmit = async (values: FormState) => {
        setBusy(true);
    const opId = newOperationId();
    const action = values.id ? "instance.update" : "instance.create";
    let savedInstanceID = "";
    try {
      if (values.id && editing) {
        // Translate the form's instance-file choice into a backend
        // action only when it actually changes something.
        let profileAction = "";
        let profileName = "";
        const currentFolder = profileFolderOf(editing);
        if (values.profileMode === "rename" && values.profileName.trim() !== currentFolder) {
          profileAction = "rename";
          profileName = values.profileName;
        } else if (values.profileMode === "swap" && values.profileName) {
          profileAction = "swap";
          profileName = values.profileName;
        }
        await InstanceService.UpdateInstance(opId, {
          id: values.id,
          name: values.name.trim(),
          browserId: values.browserId,
          sortOrder: editing.sortOrder,
          profileAction,
          profileName,
        });
        notifySuccess(`实例已更新：${values.name}`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `实例已更新：${values.name}`, "浏览器实例", action);
        savedInstanceID = values.id;
      } else {
        const created = await InstanceService.CreateInstance(opId, {
          name: values.name.trim(),
          browserId: values.browserId,
          profileMode: values.profileMode,
          profileName: values.profileMode === "default" ? "" : values.profileName,
        });
        notifySuccess(`实例已创建：${created.name}`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `实例已创建：${created.name}`, "浏览器实例", action);
        savedInstanceID = created.id;
      }
      // Sync the proxy binding to the form's choice — the same
      // single relation the proxy page writes. The instance
      // itself is already saved; a binding failure is reported
      // separately and never rolls the instance back.
      const currentNodeID = proxyBindings.find((b) => b.instanceId === savedInstanceID)?.nodeId ?? "";
      if (savedInstanceID && values.proxyNodeId !== currentNodeID) {
        const bindOpId = newOperationId();
        try {
          if (values.proxyNodeId === "") {
            await ProxyService.ClearBinding(bindOpId, savedInstanceID);
          } else {
            await ProxyService.SetBinding(bindOpId, savedInstanceID, values.proxyNodeId);
          }
          recordOperationFeedback(bindOpId, true, `实例代理已更新：${values.name}`, "代理", "proxy.binding_set");
        } catch (bindErr) {
          const message = bindErr instanceof Error ? bindErr.message : String(bindErr);
          notifyError(`实例已保存，但代理设置失败：${message}`, { operationId: bindOpId, important: true });
          recordOperationFeedback(bindOpId, false, `实例代理设置失败：${message}`, "代理", "proxy.binding_set");
        }
      }
      setFormOpen(false);
      setEditing(null);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifyError(`保存实例失败：${message}`, { operationId: opId, important: true });
      recordOperationFeedback(opId, false, `保存实例失败：${message}`, "浏览器实例", action);
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (inst: Instance, kind: "start" | "stop") => {
    setActingId(inst.id);
    const opId = newOperationId();
    const action = kind === "start" ? "instance.start" : "instance.stop";
    try {
      if (kind === "start") {
        await InstanceService.StartInstance(opId, inst.id);
        notifySuccess(`实例已启动：${inst.name}`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `实例已启动：${inst.name}`, "浏览器实例", action);
      } else {
        await InstanceService.StopInstance(opId, inst.id);
        notifySuccess(`实例已关闭：${inst.name}`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `实例已关闭：${inst.name}`, "浏览器实例", action);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifyError(`${kind === "start" ? "启动" : "关闭"}实例失败：${message}`, { operationId: opId, important: true });
      recordOperationFeedback(opId, false, message, "浏览器实例", action);
    } finally {
      setActingId(null);
      await refreshInstances();
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const opId = newOperationId();
    const action = pendingDelete.withProfile ? "instance.delete_with_profile" : "instance.delete";
    try {
      if (pendingDelete.withProfile) {
        await InstanceService.DeleteInstanceAndProfile(opId, pendingDelete.instance.id);
        notifySuccess(`实例及其实例文件已删除：${pendingDelete.instance.name}`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `实例及其实例文件已删除：${pendingDelete.instance.name}`, "浏览器实例", action);
      } else {
        await InstanceService.DeleteInstance(opId, pendingDelete.instance.id);
        notifySuccess(`实例已删除（实例文件保留）：${pendingDelete.instance.name}`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `实例已删除（实例文件保留）：${pendingDelete.instance.name}`, "浏览器实例", action);
      }
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifyError(`删除实例失败：${message}`, { operationId: opId, important: true });
      recordOperationFeedback(opId, false, `删除实例失败：${message}`, "浏览器实例", action);
    } finally {
      setBusy(false);
    }
  };

  // --- Batch operations -------------------------------------------------
  // Batch start/stop/delete run the existing single-instance
  // operations sequentially, in displayed order. Eligibility is
  // planned up front (planBatch mirrors the single-instance
  // gates); one failure never stops the remaining items, and the
  // outcome is reported per item when the batch finishes.

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(displayInstances.map((i) => i.id)) : new Set());
  };

  const executeBatch = async (action: BatchAction, plan: BatchPlanItem[]) => {
    setBatchBusy(true);
    const verb = BATCH_VERB[action];
    const okNames: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    const skipped = plan
      .filter((p) => !p.run)
      .map((p) => ({ name: p.name, reason: p.reason }));
    const items = plan.filter((p) => p.run);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setBatchProgress({ verb, done: i, total: items.length, current: item.name });
      const opId = newOperationId();
      try {
        if (action === "start") await InstanceService.StartInstance(opId, item.id);
        else if (action === "stop") await InstanceService.StopInstance(opId, item.id);
        else await InstanceService.DeleteInstance(opId, item.id);
        okNames.push(item.name);
        const doneMessage =
          action === "delete" ? `实例已删除（实例文件保留）：${item.name}` : `实例已${verb}：${item.name}`;
        recordOperationFeedback(opId, true, doneMessage, "浏览器实例", BATCH_OP_ACTION[action]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ name: item.name, reason: message });
        recordOperationFeedback(opId, false, `${verb}实例失败：${message}`, "浏览器实例", BATCH_OP_ACTION[action]);
      }
    }
    await refreshInstances();
    setSelectedIds(new Set());
    notifyBatchResult(`批量${verb}完成`, okNames, skipped, failed);
    setBatchProgress(null);
    setBatchBusy(false);
  };

  const runBatch = (action: BatchAction) => {
    const plan = planBatch(
      action,
      displayInstances.filter((i) => selectedIds.has(i.id)),
    );
    // Deletion always asks first — unless nothing is deletable,
    // in which case the skip reasons are the whole answer.
    if (action === "delete" && plan.some((p) => p.run)) {
      setBatchDeletePlan(plan);
      return;
    }
    void executeBatch(action, plan);
  };

  // --- Batch create -------------------------------------------------------

  const openBatchCreate = () => {
    setBatchCreate({ prefix: "", count: "1", browserId: "" });
    setBatchCreateError(null);
  };

  const submitBatchCreate = async () => {
    if (!batchCreate) return;
    if (!browsersLoaded) {
      setBatchCreateError("内核列表尚未加载完成，无法创建。请等待加载完成或重新加载页面。");
      return;
    }
    if (!batchCreate.browserId) {
      setBatchCreateError("请选择实例内核。");
      return;
    }
    setBatchCreateBusy(true);
    try {
      // Conflict-check against a fresh list, not the polled
      // cache; the backend still re-checks every single name.
      const fresh = await InstanceService.ListInstances();
      const plan = planBatchCreate(
        batchCreate.prefix,
        Number(batchCreate.count),
        new Set((fresh ?? []).map((i) => i.name)),
      );
      if (!plan.ok) {
        setBatchCreateError(plan.error);
        return;
      }
      const okNames: string[] = [];
      const failed: { name: string; reason: string }[] = [];
      for (const name of plan.names) {
        const opId = newOperationId();
        try {
          const created = await InstanceService.CreateInstance(opId, {
            name,
            browserId: batchCreate.browserId,
            profileMode: "default",
            profileName: "",
          });
          okNames.push(created.name);
          recordOperationFeedback(opId, true, `实例已创建：${created.name}`, "浏览器实例", "instance.create");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ name, reason: message });
          recordOperationFeedback(opId, false, `创建实例失败：${message}`, "浏览器实例", "instance.create");
        }
      }
      setBatchCreate(null);
      await refresh();
      notifyBatchResult("批量创建完成", okNames, [], failed);
    } catch (err) {
      setBatchCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchCreateBusy(false);
    }
  };

  // --- Instance-file picker -------------------------------------------------
  // The picker list is fetched fresh on every open attempt: if no
  // unbound instance file exists right now, the dialog does not
  // open at all and the form keeps its current value.

  const openProfilePicker = async (currentProfileName: string) => {
    if (!formOpen) return;
    setProfileNote(null);
    setPickerBusy(true);
    try {
      const list = await InstanceService.ListAvailableProfiles();
      const options = list ?? [];
      if (options.length === 0) {
        setProfileNote("目前没有未绑定的实例文件。");
        return;
      }
      setProfilePicker({
        options,
        picked: options.some((o) => o.name === currentProfileName) ? currentProfileName : "",
      });
    } catch (err) {
      setProfileNote(`获取实例文件列表失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPickerBusy(false);
    }
  };

  const confirmProfilePicker = () => {
    if (!profilePicker || !profilePicker.picked) return;
    setAppliedProfileName(profilePicker.picked);
    setProfilePicker(null);
  };

  const allSelected =
    displayInstances.length > 0 && displayInstances.every((i) => selectedIds.has(i.id));

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col px-6 py-6">
      {/* 顶部功能栏：常驻显示，按功能组整体换行。创建组
          （新建实例 / 批量创建）与批量操作组（批量启动 / 批量
          关闭 / 批量删除 / 取消选择）各自保持单行不拆分；宽度
          不足时批量操作组整体换到下一行。批量按钮只在存在
          选择时可用，不再使用勾选后弹出的批量操作栏，也不再
          单独显示选择计数。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
          <button
            type="button"
            onClick={openCreate}
            disabled={batchBusy}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-(--accent) px-3 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={14} /> 新建实例
          </button>
          <button
            type="button"
            onClick={openBatchCreate}
            disabled={batchBusy}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Layers size={14} /> 批量创建
          </button>
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
          <button
            type="button"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={() => runBatch("start")}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            批量启动
          </button>
          <button
            type="button"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={() => runBatch("stop")}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            批量关闭
          </button>
          <button
            type="button"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={() => runBatch("delete")}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--danger) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={batchBusy || selectedIds.size === 0}
            onClick={() => setSelectedIds(new Set())}
            className="flex h-9 shrink-0 items-center rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:cursor-not-allowed disabled:opacity-40"
          >
            取消选择
          </button>
        </div>
      </div>

      {batchProgress && (
        <p className="mt-3 shrink-0 text-xs text-(--text-dim)" role="status">
          正在批量{batchProgress.verb}：{batchProgress.done}/{batchProgress.total} · 当前 {batchProgress.current}
        </p>
      )}

      {pollPaused && (
        <p className="mt-3 shrink-0 text-xs text-(--warn)" role="status">
          自动刷新已暂停
          <button
            type="button"
            className="ml-2 underline underline-offset-2"
            onClick={() => {
              pollFails.current = 0;
              setPollPaused(false);
              void refreshInstances();
            }}
          >
            重试
          </button>
        </p>
      )}

      {browsersError && (
        <div className="mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-sm text-(--danger)">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">
            内核列表加载失败：{browsersError}。保存功能已暂停，以免误清除实例的内核关联。
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            重新加载
          </button>
        </div>
      )}


      <InstanceTable
        instances={instances}
        displayInstances={displayInstances}
        loading={loading}
        instancesError={instancesError}
        onRetryLoad={() => void load()}
        selectedIds={selectedIds}
        allSelected={allSelected}
        batchBusy={batchBusy}
        browsersLoaded={browsersLoaded}
        actingId={actingId}
        proxyBindings={proxyBindings}
        onToggleSelected={toggleSelected}
        onToggleSelectAll={toggleSelectAll}
        onRunAction={runAction}
        onEdit={openEdit}
        onDelete={(inst) => setPendingDelete({ instance: inst, withProfile: false })}
      />

      {formOpen && (
        <InstanceFormDialog
          editing={editing}
          initial={formInitial}
          browsers={browsers}
          browsersLoaded={browsersLoaded}
          browsersError={browsersError}
          proxyNodes={proxyNodes}
          proxyBindings={proxyBindings}
          busy={busy}
          pickerBusy={pickerBusy}
          profileNote={profileNote}
          appliedProfileName={appliedProfileName}
          onAppliedProfileName={() => setAppliedProfileName(null)}
          onOpenProfilePicker={(currentProfileName) => void openProfilePicker(currentProfileName)}
          onClearProfileNote={() => setProfileNote(null)}
          onNavigate={(page) => {
            setFormOpen(false);
            setEditing(null);
            setPage(page);
          }}
          onClose={() => {
            if (!busy) {
              setFormOpen(false);
              setEditing(null);
            }
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSubmit={handleFormSubmit}
        />
      )}

      {profilePicker && formOpen && (
        <ProfilePickerDialog
          picker={profilePicker}
          onPick={(name) => setProfilePicker({ ...profilePicker, picked: name })}
          onConfirm={confirmProfilePicker}
          onCancel={() => setProfilePicker(null)}
        />
      )}

      <DeleteDialogs
        pendingDelete={pendingDelete}
        onToggleWithProfile={() => {
          if (pendingDelete) setPendingDelete({ ...pendingDelete, withProfile: true });
        }}
        onConfirmSingle={() => void confirmDelete()}
        onCancelSingle={() => setPendingDelete(null)}
        busy={busy}
        batchDeletePlan={batchDeletePlan}
        onConfirmBatch={(plan) => {
          setBatchDeletePlan(null);
          void executeBatch("delete", plan);
        }}
        onCancelBatch={() => setBatchDeletePlan(null)}
        batchBusy={batchBusy}
      />

      <BatchCreateDialog
        batchCreate={batchCreate}
        onChange={(next) => setBatchCreate(next)}
        kernelOptions={browsers.map((b) => ({ id: b.id, label: kernelLabels.get(b.id) ?? b.name }))}
        browsersLoaded={browsersLoaded}
        busy={batchCreateBusy}
        error={batchCreateError}
        maxCount={MAX_BATCH_CREATE}
        onClose={() => {
          if (!batchCreateBusy) setBatchCreate(null);
        }}
        onCancel={() => setBatchCreate(null)}
        onSubmit={() => {
          if (!batchCreateBusy) void submitBatchCreate();
        }}
      />
    </div>
  );
}
