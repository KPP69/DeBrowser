// 添加代理配置弹窗：订阅地址、名称、本地添加、错误提示。
// 输入状态归组件内部所有（名称、订阅地址、当前页签、错误）：
// 父组件只传 open / busy 与提交回调，输入期间父组件回调身份
// 变化不会让输入框丢焦点（见 tests/ui/modalFocus.test.tsx
// 钉住的回归模式与 tests/ui/addSourceDialog.test.tsx）。
// 组件只收 props，不调用任何 Service；提交失败时把页面回调
// 抛出的错误显示在弹窗内，文件选择器取消则由页面回调静默
// 消化（resolve，不抛错），弹窗保持打开且不显示错误。
/** @jsxRuntime automatic */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { DialogLayer } from "../Modal";
import { btnPrimary, btnSecondary, inputCls, labelCls } from "./proxyStyles";
import { errText } from "./proxyUtils";

export type AddSourceTab = "subscription" | "file";

export interface AddSourceDialogProps {
  open: boolean;
  // 页面正忙（任意操作进行中）：全部控件禁用。
  busy: boolean;
  // 本次提交进行中：提交按钮显示转圈。
  submitting: boolean;
  onClose: () => void;
  // 成功时页面负责关闭弹窗；失败时抛出 Error，错误文本由
  // 本组件显示；文件选择器取消时 resolve，不抛错。
  onSubmit: (tab: AddSourceTab, name: string, url: string) => Promise<void>;
}

export default function AddSourceDialog({
  open,
  busy,
  submitting,
  onClose,
  onSubmit,
}: AddSourceDialogProps) {
  const [tab, setTab] = useState<AddSourceTab>("subscription");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError("请填写名称。");
      return;
    }
    if (tab === "subscription" && !url.trim()) {
      setError("请填写订阅地址。");
      return;
    }
    setError(null);
    try {
      await onSubmit(tab, name.trim(), url.trim());
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <DialogLayer
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      onSubmit={() => {
        if (!busy) void submit();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-(--border) bg-(--panel-bg) p-5 shadow-xl">
        <h3 className="text-base font-semibold">添加代理配置</h3>
        <div className="mt-4 inline-flex overflow-hidden rounded-md border border-(--border-strong)">
          <button
            type="button"
            className={`h-8 px-3.5 text-sm transition-colors ${tab === "subscription" ? "bg-(--accent) font-medium text-(--accent-contrast)" : "text-(--text-main) hover:bg-(--hover-bg)"}`}
            onClick={() => { setTab("subscription"); setError(null); }}
          >
            添加订阅
          </button>
          <button
            type="button"
            className={`h-8 px-3.5 text-sm transition-colors ${tab === "file" ? "bg-(--accent) font-medium text-(--accent-contrast)" : "text-(--text-main) hover:bg-(--hover-bg)"}`}
            onClick={() => { setTab("file"); setError(null); }}
          >
            本地添加
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className={labelCls}>名称</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的订阅" />
          </div>
          {tab === "subscription" ? (
            <div>
              <label className={labelCls}>订阅地址</label>
              <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </div>
          ) : (
            <p className="text-sm text-(--text-dim)">点击「添加」后将打开系统文件选择窗口，请选择 Clash/Mihomo 的 YAML 配置文件。</p>
          )}
          {error && <p className="text-sm text-(--danger)">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnSecondary} disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>
            {submitting ? <Loader2 size={15} className="animate-spin" /> : null}
            添加
          </button>
        </div>
      </div>
    </DialogLayer>
  );
}
