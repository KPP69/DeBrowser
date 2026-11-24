import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, Pause, Play, RotateCcw, Square } from "lucide-react";
import {
  SyncService,
  type SyncCandidate,
  type SyncMonitor,
  type SyncStateView,
} from "../../bindings/github.com/KPP69/DeBrowser/internal/service";
import { newOperationId, recordOperationFeedback } from "../lib/operations";
import { notifyError, notifySuccess } from "../stores/useNotificationStore";
import { useAppStore } from "../stores/useAppStore";
import { usePageRefresh } from "../hooks/usePageRefresh";
import {
  canStart,
  phaseControls,
  refreshSelection,
  type SyncSelection,
} from "./syncLogic";

/**
 * 多开同步（Stage 10）：选择一个主实例与若干跟随实例，将主
 * 实例的网页操作（经 CDP）、已确认的导航与窗口状态同步到
 * 跟随实例。页面顶部功能栏集中全部操作，下方为参与实例
 * 状态与使用说明，不读取或显示任何网页内容。
 */
export default function SyncPage() {
  const appPage = useAppStore((state) => state.page);
  const [candidates, setCandidates] = useState<SyncCandidate[]>([]);
  const [state, setState] = useState<SyncStateView | null>(null);
  const [monitors, setMonitors] = useState<SyncMonitor[]>([]);
  const [monitorId, setMonitorId] = useState(0);
  // 在途请求保护：任一同步操作执行期间禁用全部操作入口，
  // 防止连续点击造成重复请求；请求结束（成功或失败）后恢复。
  const [busy, setBusy] = useState(false);
  const refreshFailedRef = useRef(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const hasStateRef = useRef(false);
  const [monitorsError, setMonitorsError] = useState<string | null>(null);
  const selectionRef = useRef<SyncSelection>({ masterId: "", followerIds: [] });
  const [selection, setSelectionState] = useState<SyncSelection>(selectionRef.current);
  const setSelection = (next: SyncSelection) => {
    selectionRef.current = next;
    setSelectionState(next);
  };

  const sessionActive = state !== null && state.phase !== "已停止";
  const controls = phaseControls(state?.phase ?? "已停止");

  const refresh = useCallback(async () => {
    try {
      const [cands, st] = await Promise.all([
        SyncService.GetSyncCandidates(newOperationId()),
        SyncService.GetSyncState(newOperationId()),
      ]);
      const list = cands ?? [];
      setCandidates(list);
      setState(st);
      hasStateRef.current = true;
      setStatusError(null);
      refreshFailedRef.current = false;
      setSelection(
        refreshSelection(
          selectionRef.current,
          list.map((c) => ({ instanceId: c.instanceId, cdpAvailable: c.cdpAvailable })),
          st.phase !== "已停止",
          st.masterId,
        ),
      );
    } catch (err) {
      // 状态读取失败时保留上次已知状态；只在首次失败时提示
      // 一次，避免轮询期间反复弹出相同错误。从未成功读取
      // 时保留失败原因，页面显示读取失败而非伪造的停止状态。
      const message = err instanceof Error ? err.message : String(err);
      if (!hasStateRef.current) setStatusError(message);
      if (!refreshFailedRef.current) {
        refreshFailedRef.current = true;
        notifyError(`同步状态读取失败：${message}`);
      }
    }
  }, []);

  // 显示器列表在挂载与切回本页时读取（不是轮询）；
  // 加载失败时通过全局通知显示真实原因，不静默吞掉，
  // 并保留失败原因供页面区分读取失败与真实空列表。
  const loadMonitors = useCallback(() => {
    SyncService.ListSyncMonitors(newOperationId())
      .then((ms) => {
        const list = ms ?? [];
        setMonitors(list);
        setMonitorsError(null);
        // 切回页面只刷新列表，不动用户已选的显示器：只有
        // 当前选择不在新列表中时才回落到主显示器。首次加载
        // 时 monitorId 为初始值 0，同样走该分支。
        setMonitorId((cur) => {
          if (list.some((m) => m.id === cur)) return cur;
          return list.find((m) => m.primary)?.id ?? cur;
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setMonitorsError(message);
        notifyError(`加载显示器列表失败：${message}`);
      });
  }, []);

  useEffect(() => {
    void refresh();
    loadMonitors();
  }, [refresh, loadMonitors]);

  // 显示器列表只在挂载时读过一次：切回本页时重新枚举一次，
  // 以便接上/拔掉显示器后列表及时更新（首次挂载由上方
  // 加载逻辑负责）。轮询仍只刷新同步状态，不碰显示器列表。
  usePageRefresh("sync", loadMonitors);

  // 页面隐藏时停止轮询：保活后所有页面常驻，后台页面不应继续抢 IPC。
  useEffect(() => {
    if (appPage !== "sync") return;
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [refresh, appPage]);

  const run = async (
    action: string,
    fn: (op: string) => Promise<unknown>,
    okMessage: string,
  ) => {
    if (busy) return;
    setBusy(true);
    const op = newOperationId();
    try {
      await fn(op);
      recordOperationFeedback(op, true, okMessage, "sync", action);
      notifySuccess(okMessage, { operationId: op, important: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordOperationFeedback(op, false, message, "sync", action);
      notifyError(message, { operationId: op, important: true });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const toggleFollower = (id: string, checked: boolean) => {
    const cur = selectionRef.current;
    const followerIds = checked
      ? [...cur.followerIds, id]
      : cur.followerIds.filter((f) => f !== id);
    setSelection({ ...cur, followerIds });
  };

  const arrangeIds = [
    ...(selection.masterId ? [selection.masterId] : []),
    ...selection.followerIds,
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-5">
      {/* 顶部功能栏：常驻显示，按功能组整体换行。同步控制组
          （开始 / 暂停 / 恢复 / 停止）、窗口管理组（排列窗口 /
          恢复窗口）与显示器组（显示器选择）各自保持单行不
          拆分；宽度不足时按组顺序整体换行。启用与禁用沿用
          原有 phase 判断，功能栏内不展示同步状态徽标。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
  <button
            className="flex h-9 items-center gap-1.5 rounded-md bg-(--accent) px-3 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:opacity-50"
            disabled={busy || !controls.start || !canStart(selection)}
            onClick={() =>
              void run("start", (op) =>
                SyncService.StartSync(op, selection.masterId, selection.followerIds),
              "同步已开始")
            }
          >
            <Play size={14} /> 开始
          </button>
          <button
            className="flex h-9 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:opacity-50"
            disabled={busy || !controls.pause}
            onClick={() => void run("pause", (op) => SyncService.PauseSync(op), "同步已暂停")}
          >
            <Pause size={14} /> 暂停
          </button>
          <button
            className="flex h-9 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:opacity-50"
            disabled={busy || !controls.resume}
            onClick={() => void run("resume", (op) => SyncService.ResumeSync(op), "同步已恢复")}
          >
            <RotateCcw size={14} /> 恢复
          </button>
          <button
            className="flex h-9 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:opacity-50"
            disabled={busy || !controls.stop}
            onClick={() => void run("stop", (op) => SyncService.StopSync(op), "同步已停止")}
          >
            <Square size={14} /> 停止
          </button>
        
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
  <button
            className="flex h-9 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:opacity-50"
            disabled={busy || arrangeIds.length === 0}
            onClick={() =>
              void run("arrange", (op) =>
                SyncService.ArrangeSyncWindows(op, arrangeIds, monitorId),
              "窗口已排列")
            }
          >
            <AppWindow size={14} /> 排列窗口
          </button>
          <button
            className="flex h-9 items-center gap-1.5 rounded-md border border-(--border-strong) px-3 text-sm text-(--text-main) hover:bg-(--hover-bg) disabled:opacity-50"
            disabled={busy}
            onClick={() =>
              void run("restore", (op) => SyncService.RestoreSyncWindows(op), "窗口已恢复")
            }
          >
            <RotateCcw size={14} /> 恢复窗口
          </button>
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
          <select
            className="h-9 rounded-md border border-(--border-strong) bg-(--panel-bg) px-2 text-sm text-(--text-main)"
            value={monitorId}
            onChange={(e) => setMonitorId(Number(e.target.value))}
          >
            {monitors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {monitorsError && monitors.length === 0 && (
            <>
              <span className="text-sm text-(--danger)">显示器列表读取失败：{monitorsError}</span>
              <button
                type="button"
                onClick={loadMonitors}
                className="rounded-md border border-(--border-strong) bg-(--input-bg) px-3 py-1.5 text-sm text-(--text-main) hover:bg-(--hover-bg)"
              >
                重新加载
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-5 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">

      {state === null && statusError && (
        <div className="flex items-center gap-2 rounded-xl border border-(--border) bg-(--panel-bg) px-4 py-3">
          <p className="flex-1 text-sm text-(--danger)">同步状态读取失败：{statusError}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 rounded-md border border-(--border-strong) bg-(--input-bg) px-3 py-1.5 text-sm text-(--text-main) hover:bg-(--hover-bg)"
          >
            重新加载
          </button>
        </div>
      )}
      {state === null && !statusError && (
        <p className="text-sm text-(--text-faint)">正在加载同步状态…</p>
      )}

      <section className="rounded-xl border border-(--border) bg-(--panel-bg) p-4">
        <h2 className="mb-3 text-sm font-medium text-(--text-main)">同步控制</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-(--text-faint)">
              <th className="py-1 pr-2 font-normal">实例</th>
              <th className="py-1 pr-2 font-normal">内核</th>
              <th className="py-1 pr-2 font-normal">主控</th>
              <th className="py-1 pr-2 font-normal">跟随</th>
              <th className="py-1 font-normal">同步状态</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              const participant = state?.participants?.find((p) => p.instanceId === c.instanceId);
              return (
                <tr key={c.instanceId} className="border-t border-(--border)">
                  <td className="py-1.5 pr-2 text-(--text-main)">{c.name}</td>
                  <td className="py-1.5 pr-2 text-(--text-dim)">{c.kernelName || "—"}</td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="radio"
                      name="sync-master"
                      disabled={sessionActive || !c.cdpAvailable}
                      checked={selection.masterId === c.instanceId}
                      onChange={() =>
                        setSelection({
                          masterId: c.instanceId,
                          followerIds: selectionRef.current.followerIds.filter(
                            (f) => f !== c.instanceId,
                          ),
                        })
                      }
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="checkbox"
                      disabled={
                        sessionActive || !c.cdpAvailable || selection.masterId === c.instanceId
                      }
                      checked={selection.followerIds.includes(c.instanceId)}
                      onChange={(e) => toggleFollower(c.instanceId, e.target.checked)}
                    />
                  </td>
                  <td className="py-1.5 text-(--text-dim)">
                    {participant
                      ? participant.status +
                        (participant.reason ? `（${participant.reason}）` : "")
                      : c.cdpAvailable
                        ? "可同步"
                        : c.reason}
                  </td>
                </tr>
              );
            })}
            {candidates.length === 0 && state !== null && (
              <tr>
                <td colSpan={5} className="py-3 text-(--text-faint)">
                  尚无浏览器实例。请先在「浏览器实例」中创建并启动实例。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-(--border) bg-(--panel-bg) p-4 text-sm leading-relaxed text-(--text-dim)">
        <h2 className="mb-2 text-sm font-medium text-(--text-main)">使用说明</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>选一个主控，勾选跟随实例</li>
          <li>先点「排列窗口」，后点「开始同步」</li>
          <li>同步期间窗口重叠，同步暂停，再点「排列窗口」即可恢复</li>
        </ul>
      </section>
      </div>
    </div>
  );
}
