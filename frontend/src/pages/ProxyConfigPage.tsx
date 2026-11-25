import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Plus, Square } from "lucide-react";
import {
  InstanceService,
  ProxyService,
  type BindingView,
  type CoreStatusView,
  type NodeTestResultView,
  type NodeView,
  type SourceView,
} from "../../bindings/github.com/KPP69/DeBrowser/internal/service";
import type { Instance } from "../../bindings/github.com/KPP69/DeBrowser/internal/model";
import { notifyError, notifySuccess } from "../stores/useNotificationStore";
import { newOperationId, recordOperationFeedback } from "../lib/operations";
import { useAppStore } from "../stores/useAppStore";
import { usePageRefresh } from "../hooks/usePageRefresh";
import AddSourceDialog, { type AddSourceTab } from "../components/proxy/AddSourceDialog";
import SourceCard from "../components/proxy/SourceCard";
import BindingCard from "../components/proxy/BindingCard";
import DeleteSourceDialog from "../components/proxy/DeleteSourceDialog";
import { btnPrimary, btnSecondary } from "../components/proxy/proxyStyles";
import { errText, PICKER_CANCELLED } from "../components/proxy/proxyUtils";

// 代理配置页面：顶部操作区、代理源卡片、下方绑定区（代理
// 节点卡片与实例列表卡片，窗口较窄时上下排列）；三个列表
// 标题固定、内容独立纵向滚动，无任何分页。绑定数据只有
// 一份：本页与浏览器实例页面读写同一个 ProxyService 绑定关系。
export default function ProxyConfigPage() {
  const [status, setStatus] = useState<CoreStatusView | null>(null);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDeleteSource, setConfirmDeleteSource] = useState<SourceView | null>(null);
  // 测速：仅在用户点击时对全部节点逐个测试，结果只
  // 用于本页显示，不保存、不影响绑定。
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, NodeTestResultView>>({});
  const loadedRef = useRef(false);

  const reload = useCallback(async (): Promise<string | null> => {
    try {
      const [st, srcs, nds, bds, insts] = await Promise.all([
        ProxyService.GetCoreStatus(),
        ProxyService.ListSources(),
        ProxyService.ListNodes(),
        ProxyService.ListBindings(),
        InstanceService.ListInstances(),
      ]);
      setStatus(st);
      setSources(srcs ?? []);
      setNodes(nds ?? []);
      setBindings(bds ?? []);
      setInstances(insts ?? []);
      loadedRef.current = true;
      setLoadError(null);
      return null;
    } catch (e) {
      const message = errText(e);
      if (!loadedRef.current) setLoadError(message);
      return message;
    } finally {
      setLoading(false);
    }
  }, []);

  // 已访问页面保持挂载，其他页面刚改过的数据不会自己刷新：
  // 每次回到本页时静默重载一次（首次挂载由原有加载逻辑负责）。
  const appPage = useAppStore((state) => state.page);
  usePageRefresh("proxyconfig", reload);

  // 轮询只刷新核心状态：节点、绑定、实例列表在操作后刷新，
  // 避免每 3 秒整页重渲染。
  const reloadStatus = useCallback(async () => {
    try {
      setStatus(await ProxyService.GetCoreStatus());
    } catch {
      // 轮询失败保持上次状态，不打断操作。
    }
  }, []);

  useEffect(() => {
    void reload().then((message) => {
      if (message) notifyError(`加载代理配置失败：${message}`);
    });
  }, [reload]);

  // 页面打开期间保持核心状态、绑定与实例列表新鲜（新建的
  // 实例自动出现，删除的实例自动消失）。
  useEffect(() => {
    if (appPage !== "proxyconfig") return;
    const timer = setInterval(() => void reloadStatus(), 3000);
    return () => clearInterval(timer);
  }, [reloadStatus, appPage]);

  const bindingByInstance = useMemo(() => {
    const map = new Map<string, BindingView>();
    for (const b of bindings) map.set(b.instanceId, b);
    return map;
  }, [bindings]);

  const runTest = async () => {
    const nodeIds = nodes.map((n) => n.id);
    if (testing || nodeIds.length === 0) return;
    setTesting(true);
    const opId = newOperationId();
    try {
      const results = await ProxyService.TestNodes(opId, nodeIds);
      setTestResults((prev) => ({ ...prev, ...Object.fromEntries((results ?? []).map((r) => [r.nodeId, r])) }));
      const okCount = (results ?? []).filter((r) => r.ok).length;
      notifySuccess(`测速完成：${okCount}/${nodeIds.length} 个节点可用`, { operationId: opId, important: true });
      recordOperationFeedback(opId, true, "节点测速完成", "代理", "proxy.node_test");
    } catch (e) {
      const message = errText(e);
      notifyError(`测速失败：${message}`, { operationId: opId, important: true });
      recordOperationFeedback(opId, false, `测速失败：${message}`, "代理", "proxy.node_test");
    } finally {
      setTesting(false);
    }
  };

  const updateSource = (src: SourceView) => {
    if (src.kind === "subscription") {
      void run(`refresh-${src.id}`, "proxy.source_refresh", `订阅「${src.name}」已更新`, async (opId) => {
        await ProxyService.RefreshSource(opId, src.id);
      });
      return;
    }
    // 本地文件：重新选择文件更新；取消选择静默结束。
    if (busy) return;
    setBusy(`refresh-${src.id}`);
    const opId = newOperationId();
    void (async () => {
      try {
        await ProxyService.ReimportFileSource(opId, src.id);
        notifySuccess(`本地配置「${src.name}」已更新`, { operationId: opId, important: true });
        recordOperationFeedback(opId, true, `本地配置「${src.name}」已更新`, "代理", "proxy.source_reimport");
      } catch (e) {
        const message = errText(e);
        if (message !== PICKER_CANCELLED) {
          notifyError(`更新本地配置失败：${message}`, { operationId: opId, important: true });
          recordOperationFeedback(opId, false, `更新本地配置失败：${message}`, "代理", "proxy.source_reimport");
        }
      } finally {
        setBusy(null);
        await reload();
      }
    })();
  };

  const run = async (key: string, action: string, label: string, fn: (opId: string) => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    const opId = newOperationId();
    try {
      await fn(opId);
      notifySuccess(label, { operationId: opId, important: true });
      recordOperationFeedback(opId, true, label, "代理", action);
    } catch (e) {
      const message = errText(e);
      notifyError(`${label}失败：${message}`, { operationId: opId, important: true });
      recordOperationFeedback(opId, false, `${label}失败：${message}`, "代理", action);
    } finally {
      setBusy(null);
      await reload();
    }
  };

  const toggleCore = () => {
    if (!status) return;
    const running = status.running;
    void run("core", running ? "proxy.core_stop" : "proxy.core_start", running ? "代理核心已关闭" : "代理核心已启动", async (opId) => {
      if (running) await ProxyService.StopCore(opId);
      else await ProxyService.StartCore(opId);
    });
  };

  // 添加来源：表单校验与错误显示在 AddSourceDialog 内部；这里
  // 只做服务调用。成功时关闭弹窗（弹窗随之卸载，输入状态自然
  // 清空）；失败时把错误抛回弹窗显示；文件选择器取消时静默
  // 结束，弹窗保持打开且不显示错误。
  const submitAdd = async (tab: AddSourceTab, name: string, url: string) => {
    setBusy("add");
    const opId = newOperationId();
    try {
      const kind = tab === "subscription" ? "订阅" : "配置文件";
      const view =
        tab === "subscription"
          ? await ProxyService.AddSubscriptionSource(opId, name, url)
          : await ProxyService.AddFileSource(opId, name);
      notifySuccess(`${kind}已添加：${view.name}（${view.nodeCount} 个节点）`, { operationId: opId, important: true });
      recordOperationFeedback(opId, true, `${kind}已添加：${view.name}`, "代理", tab === "subscription" ? "proxy.source_add_subscription" : "proxy.source_add_file");
      setAddOpen(false);
    } catch (e) {
      const message = errText(e);
      if (message !== PICKER_CANCELLED) {
        recordOperationFeedback(opId, false, `添加配置失败：${message}`, "代理", "proxy.source_add");
        throw new Error(message);
      }
    } finally {
      setBusy(null);
      await reload();
    }
  };

  const changeBinding = (instance: Instance, nodeID: string) => {
    const label = nodeID === "" ? `实例「${instance.name}」已取消代理` : `实例「${instance.name}」的代理已更新`;
    void run(`bind-${instance.id}`, "proxy.binding_set", label, async (opId) => {
      if (nodeID === "") await ProxyService.ClearBinding(opId, instance.id);
      else await ProxyService.SetBinding(opId, instance.id, nodeID);
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 p-5">
      {/* 顶部操作区：启动、添加依次靠左排列 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button type="button" className={status?.running ? btnSecondary : btnPrimary} disabled={busy !== null || !status} onClick={toggleCore}>
          {busy === "core" ? <Loader2 size={15} className="animate-spin" /> : status?.running ? <Square size={15} /> : <Play size={15} />}
          {status?.running ? "关闭" : "启动"}
        </button>
        <button type="button" className={btnSecondary} disabled={busy !== null} onClick={() => setAddOpen(true)}>
          <Plus size={15} />
          添加
        </button>
        <span className="ml-1 text-sm text-(--text-dim)">
          {status === null ? "正在读取核心状态…" : status.running ? `代理核心运行中（Mihomo ${status.version}）` : "代理核心未启动"}
        </span>
        {status?.message && <span className="text-sm text-(--danger)">{status.message}</span>}
      </div>

      {loading && !loadedRef.current ? (
        <div className="flex flex-1 items-center justify-center text-sm text-(--text-dim)">
          <Loader2 size={16} className="mr-2 animate-spin" /> 正在加载…
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-sm text-(--danger)">加载代理配置失败：{loadError}</p>
          <button type="button" className={btnSecondary} onClick={() => void reload()}>重试</button>
        </div>
      ) : (
        <>
          {/* 代理源卡片：独占一行；标题与表头固定，
              数据行内部纵向滚动（无分页）。 */}
          <SourceCard
            sources={sources}
            disabled={busy !== null}
            onRefresh={updateSource}
            onRequestDelete={setConfirmDeleteSource}
          />

          {/* 下方左右并排：代理节点卡片与实例列表卡片，
              等高，各自内部纵向滚动（无分页）。 */}
          <BindingCard
            nodes={nodes}
            testResults={testResults}
            testing={testing}
            disabled={busy !== null}
            onTest={() => void runTest()}
            instances={instances}
            bindingByInstance={bindingByInstance}
            onChangeBinding={changeBinding}
          />
        </>
      )}

      {/* 添加弹窗 */}
      {addOpen && (
        <AddSourceDialog
          open
          busy={busy !== null}
          submitting={busy === "add"}
          onClose={() => setAddOpen(false)}
          onSubmit={submitAdd}
        />
      )}

      {/* 删除来源确认 */}
      <DeleteSourceDialog
        source={confirmDeleteSource}
        busy={busy !== null}
        onCancel={() => setConfirmDeleteSource(null)}
        onConfirm={(src) => {
          setConfirmDeleteSource(null);
          void run(`delete-${src.id}`, "proxy.source_delete", `代理配置「${src.name}」已删除`, async (opId) => {
            await ProxyService.DeleteSource(opId, src.id);
          });
        }}
      />
    </div>
  );
}
