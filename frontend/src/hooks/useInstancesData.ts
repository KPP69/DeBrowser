// Data loading and refresh for the instances page: the instance
// list, the registered browsers (kernels), and the proxy nodes /
// bindings the table column and the form selector read. No page
// UI state lives here — selection, dialogs and delete targets
// stay in the page; this hook only owns the loaded data, the
// list-request sequence, the consecutive-failure poll pause, and
// the load / refresh functions.
// /** @jsxRuntime automatic */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserService,
  InstanceService,
  ProxyService,
  type BindingView,
  type BrowserView,
  type NodeView,
} from "../../bindings/github.com/KPP69/DeBrowser/internal/service";
import type { Instance } from "../../bindings/github.com/KPP69/DeBrowser/internal/model";
import { notifyError } from "../stores/useNotificationStore";
import { useAppStore } from "../stores/useAppStore";
import { usePageRefresh } from "./usePageRefresh";
import { kernelOptionLabels, sortInstancesByName } from "../pages/instancesLogic";

export interface InstancesData {
  instances: Instance[];
  instancesError: string | null;
  // The list is displayed in natural name order; selection and
  // select-all always refer to exactly this displayed list.
  displayInstances: Instance[];
  browsers: BrowserView[];
  kernelLabels: Map<string, string>;
  // browsersLoaded is true only after ListBrowsers has succeeded.
  // While it is false (still loading, or the load failed), saving
  // is disabled: judging an association against a not-yet-loaded
  // list would mistake it for a missing registration, and saving
  // would then clear the association in the database.
  browsersLoaded: boolean;
  browsersError: string | null;
  proxyNodes: NodeView[];
  proxyBindings: BindingView[];
  loading: boolean;
  pollPaused: boolean;
  // Full reload (initial=true shows the loading state and closes
  // the editing gate first); refresh is the silent variant.
  load: () => void;
  refresh: () => Promise<void>;
  refreshInstances: () => Promise<void>;
  resumePolling: () => void;
}

export function useInstancesData(): InstancesData {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [browsersLoaded, setBrowsersLoaded] = useState(false);
  const [browsersError, setBrowsersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [proxyNodes, setProxyNodes] = useState<NodeView[]>([]);
  const [proxyBindings, setProxyBindings] = useState<BindingView[]>([]);
  // 列表请求序号：轮询与操作后刷新并发时，只接受最后发出的响应。
  const listSeq = useRef(0);
  const pollFails = useRef(0);
  // 轮询返回与上次相同的数据时跳过 setState，避免整张表每 2.5 秒
  // 无意义重渲染一次。
  const lastListJSON = useRef("");
  const lastBindingsJSON = useRef("");
  const [pollPaused, setPollPaused] = useState(false);

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

  const load = useCallback(() => {
    void loadAll(true);
  }, [loadAll]);
  const refresh = useCallback(() => loadAll(false), [loadAll]);

  const resumePolling = useCallback(() => {
    pollFails.current = 0;
    setPollPaused(false);
    void refreshInstances();
  }, [refreshInstances]);

  const displayInstances = useMemo(() => sortInstancesByName(instances), [instances]);
  const kernelLabels = useMemo(() => kernelOptionLabels(browsers), [browsers]);

  // 已访问页面保持挂载，其他页面刚改过的数据不会自己刷新：
  // 每次回到本页时静默重载一次（首次挂载由下面的加载逻辑负责）。
  const appPage = useAppStore((state) => state.page);
  usePageRefresh("instances", refresh);

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

  return {
    instances,
    instancesError,
    displayInstances,
    browsers,
    kernelLabels,
    browsersLoaded,
    browsersError,
    proxyNodes,
    proxyBindings,
    loading,
    pollPaused,
    load,
    refresh,
    refreshInstances,
    resumePolling,
  };
}
