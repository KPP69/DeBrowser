// Create/edit instance form dialog for the instances page. The
// form state lives here (name, kernel, profile-file mode/name,
// proxy node, local validation errors); the page passes the
// initial values and the submit handler, and owns the picker
// state behind the 选择 mode. On a save failure the page does
// not close the dialog, so the form stays open with its values.
/** @jsxRuntime automatic */
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Modal";
import ProxyNodePicker from "../ProxyNodePicker";
import { inputCls, labelCls } from "./formStyles";
import ProfileFileField from "./ProfileFileField";
import { kernelOptionLabels } from "../../pages/instancesLogic";
import type { Instance } from "../../../bindings/github.com/KPP69/DeBrowser/internal/model";
import type {
  BindingView,
  BrowserView,
  NodeView,
} from "../../../bindings/github.com/KPP69/DeBrowser/internal/service";

export interface FormState {
  id?: string;
  name: string;
  // browserId is the ID of one registered browser (「浏览器内核」
  // page) associated with the instance. The options come only
  // from actual registrations — never from free text — so an
  // association always resolves to a real registered path.
  // Required when creating; on edit, "" clears an association.
  browserId: string;
  // Create: "default" | "custom" | "existing".
  // Edit: "rename" | "swap" (no default option on edit).
  profileMode: string;
  profileName: string;
  // proxyNodeId is the ID of the proxy node this instance is
  // bound to ("" = 不使用代理). The binding itself lives in
  // the proxy module's single binding table: this form and the
  // proxy page read and write the same relation through
  // ProxyService.
  proxyNodeId: string;
}

export const EMPTY_FORM: FormState = {
  name: "",
  browserId: "",
  profileMode: "default",
  profileName: "",
  proxyNodeId: "",
};

export interface InstanceFormDialogProps {
  editing: Instance | null;
  initial: FormState;
  browsers: BrowserView[];
  browsersLoaded: boolean;
  browsersError: string | null;
  proxyNodes: NodeView[];
  proxyBindings: BindingView[];
  busy: boolean;
  pickerBusy: boolean;
  profileNote: string | null;
  // Name confirmed in the profile picker since the last apply;
  // the dialog applies it to the profile field once, then
  // reports back so the page can clear it.
  appliedProfileName: string | null;
  onAppliedProfileName: () => void;
  onOpenProfilePicker: (currentProfileName: string) => void;
  onClearProfileNote: () => void;
  onNavigate: (page: "kernels" | "proxyconfig") => void;
  onClose: () => void;
  onCancel: () => void;
  onSubmit: (values: FormState) => Promise<void>;
}

export default function InstanceFormDialog({
  editing,
  initial,
  browsers,
  browsersLoaded,
  browsersError,
  proxyNodes,
  proxyBindings,
  busy,
  pickerBusy,
  profileNote,
  appliedProfileName,
  onAppliedProfileName,
  onOpenProfilePicker,
  onClearProfileNote,
  onNavigate,
  onClose,
  onCancel,
  onSubmit,
}: InstanceFormDialogProps) {
  const [name, setName] = useState(initial.name);
  const [browserId, setBrowserId] = useState(initial.browserId);
  const [profileMode, setProfileMode] = useState(initial.profileMode);
  const [profileName, setProfileName] = useState(initial.profileName);
  const [proxyNodeId, setProxyNodeId] = useState(initial.proxyNodeId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (appliedProfileName !== null) {
      setProfileName(appliedProfileName);
      onAppliedProfileName();
    }
  }, [appliedProfileName]);

  const kernelLabels = useMemo(() => kernelOptionLabels(browsers), [browsers]);
  const editingRunning = editing ? ["running", "starting", "stopping"].includes(editing.status) : false;

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError("实例名称不能为空。");
      return;
    }
    if (!browsersLoaded) {
      // Never let a save carry a browserId that was derived from
      // an incompletely loaded registration list.
      setError("内核列表尚未加载完成，无法保存。请等待加载完成或重新加载页面。");
      return;
    }
    if (!editing && !browserId) {
      setError("请选择实例内核。");
      return;
    }
    if (!editing && profileMode === "existing" && !profileName) {
      setError("请选择实例文件。");
      return;
    }
    if (editing && profileMode === "swap" && !profileName) {
      setError("请选择要更换的实例文件。");
      return;
    }
    setError(null);
    await onSubmit({
      id: initial.id,
      name,
      browserId,
      profileMode,
      profileName,
      proxyNodeId,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onSubmit={() => {
        if (!busy) void submit();
      }}
    >
      <h3 className="text-base font-semibold">{editing ? "编辑实例" : "新建实例"}</h3>
      <div className="mt-4 space-y-3">
        <div>
          <label className={labelCls}>实例名称</label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：工作号"
          />
          {!name.trim() && (
            <p className="mt-1 text-xs text-(--danger)">实例名称不能为空</p>
          )}
        </div>
        <div>
          <label className={labelCls}>实例内核{editing ? "" : "（必选）"}</label>
          <select
            className={inputCls}
            value={browserId}
            disabled={!browsersLoaded || editingRunning}
            onChange={(e) => setBrowserId(e.target.value)}
          >
            <option value="">{editing ? "不选择内核" : "请选择内核"}</option>
            {browsers.map((b) => (
              <option key={b.id} value={b.id}>
                {kernelLabels.get(b.id) ?? b.name}
              </option>
            ))}
          </select>
          {browsersError ? (
            <p className="mt-1 text-xs text-(--danger)">内核列表加载失败：{browsersError}</p>
          ) : !browsersLoaded ? (
            <p className="mt-1 text-xs text-(--text-faint)">内核列表加载中…</p>
          ) : browsers.length === 0 ? (
            <p className="mt-1 text-xs text-(--text-faint)">
              尚未登记任何浏览器内核。
              <button
                type="button"
                className="text-(--accent) underline underline-offset-2"
                onClick={() => onNavigate("kernels")}
              >
                前往「浏览器内核」页面添加
              </button>
            </p>
          ) : null}
          {editing && editing.kernelId !== "" && !browsers.some((b) => b.id === editing.kernelId) ? (
            <p className="mt-1 text-xs text-(--text-faint)">
              原关联的内核登记已不存在，当前按未关联处理；保存后将清除原关联。
            </p>
          ) : editing && editing.kernelId === "" && (editing.kernelName || editing.kernelVersion) ? (
            <p className="mt-1 text-xs text-(--text-faint)">
              该实例保存有历史内核记录：{editing.kernelName}
              {editing.kernelVersion ? ` ${editing.kernelVersion}` : ""}
              （未关联登记内核）。不选择内核时此记录会保留；选择上方内核后将改为关联该登记。
            </p>
          ) : null}
        </div>
        <div>
          <label className={labelCls}>代理节点</label>
          <ProxyNodePicker
            nodes={proxyNodes}
            value={proxyNodeId}
            onChange={(nodeId) => setProxyNodeId(nodeId)}
            ariaLabel="代理节点"
          />
          {editingRunning && editing && (
            <p className="mt-1 text-xs text-(--text-faint)">
              {(() => {
                const current = proxyBindings.find((b) => b.instanceId === editing.id)?.nodeId ?? "";
                if (proxyNodeId === current) return null;
                if (current && proxyNodeId) return "运行中更换节点立即生效（端口不变）。";
                if (!current && proxyNodeId) return "首次绑定在下次启动该实例时生效。";
                return "解绑在下次启动该实例时生效。";
              })()}
            </p>
          )}
          {proxyNodes.length === 0 && (
            <p className="mt-1 text-xs text-(--text-faint)">
              尚未导入任何代理节点。
              <button
                type="button"
                className="text-(--accent) underline underline-offset-2"
                onClick={() => onNavigate("proxyconfig")}
              >
                前往「代理配置」页面添加
              </button>
            </p>
          )}
        </div>
        <ProfileFileField
          editing={editing}
          profileMode={profileMode}
          profileName={profileName}
          pickerBusy={pickerBusy}
          profileNote={profileNote}
          onModeChange={(mode, name) => {
            setProfileMode(mode);
            setProfileName(name);
            onClearProfileNote();
          }}
          onProfileNameChange={setProfileName}
          onOpenProfilePicker={onOpenProfilePicker}
        />
        {error && <p className="text-sm text-(--danger)">{error}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-(--border) px-3 py-1.5 text-sm text-(--text-dim) hover:bg-(--hover-bg)"
        >
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded-md bg-(--accent) px-3 py-1.5 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </Dialog>
  );
}
