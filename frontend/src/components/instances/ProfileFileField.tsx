// Instance-file field of the instance form: the create/edit
// mode switch (default / custom / existing, rename / swap) with
// the picker box in 选择 mode. Props only — the form dialog
// keeps the field values.
/** @jsxRuntime automatic */
import { ChevronDown } from "lucide-react";
import { inputCls, labelCls, modeButtonCls, modeGroupCls } from "./formStyles";
import { ACTIVE_STATUSES, profileFolderOf } from "../../pages/instancesLogic";
import type { Instance } from "../../../bindings/github.com/KPP69/DeBrowser/internal/model";

export interface ProfileFileFieldProps {
  editing: Instance | null;
  profileMode: string;
  profileName: string;
  pickerBusy: boolean;
  profileNote: string | null;
  onModeChange: (mode: string, profileName: string) => void;
  onProfileNameChange: (name: string) => void;
  onOpenProfilePicker: (currentProfileName: string) => void;
}

export default function ProfileFileField({
  editing,
  profileMode,
  profileName,
  pickerBusy,
  profileNote,
  onModeChange,
  onProfileNameChange,
  onOpenProfilePicker,
}: ProfileFileFieldProps) {
  const editingActive = editing ? ACTIVE_STATUSES.has(editing.status) : false;
  const editingUnknown = editing?.status === "unknown";

  // The clickable box shown in the form's 选择 mode: it never
  // expands inline; it opens the picker dialog (or explains why
  // there is nothing to pick).
  const profilePickerBox = (disabled: boolean) => (
    <>
      <button
        type="button"
        disabled={disabled || pickerBusy}
        onClick={() => onOpenProfilePicker(profileName)}
        className={`${inputCls} flex items-center justify-between text-left`}
      >
        <span className={profileName ? "" : "text-(--text-faint)"}>
          {profileName || "点击选择实例文件"}
        </span>
        <ChevronDown size={14} className="shrink-0 text-(--text-faint)" />
      </button>
      {profileNote && <p className="mt-1 text-xs text-(--text-faint)">{profileNote}</p>}
    </>
  );

  return (
    <div>
      <label className={labelCls}>实例文件</label>
      {!editing ? (
        <div>
          <div className={modeGroupCls} role="group" aria-label="实例文件方式">
            <button
              type="button"
              aria-pressed={profileMode === "default"}
              className={modeButtonCls(profileMode === "default")}
              onClick={() => onModeChange("default", "")}
            >
              默认
            </button>
            <button
              type="button"
              aria-pressed={profileMode === "custom"}
              className={modeButtonCls(profileMode === "custom")}
              onClick={() => onModeChange("custom", "")}
            >
              自定
            </button>
            <button
              type="button"
              aria-pressed={profileMode === "existing"}
              className={modeButtonCls(profileMode === "existing")}
              onClick={() => onModeChange("existing", "")}
            >
              选择
            </button>
          </div>
          {profileMode === "default" && (
            <p className="mt-2 text-xs text-(--text-faint)">
              自动分配实例文件：P-1、P-2、P-3……已分配过的编号不会重复使用。
            </p>
          )}
          {profileMode === "custom" && (
            <input
              className={`${inputCls} mt-2`}
              value={profileName}
              onChange={(e) => onProfileNameChange(e.target.value)}
              placeholder="实例文件名称，例如：工作账号"
            />
          )}
          {profileMode === "existing" && <div className="mt-2">{profilePickerBox(false)}</div>}
        </div>
      ) : (
        <div>
          <p className="text-xs text-(--text-faint)">
            当前实例文件：{profileFolderOf(editing)}
            <span className="font-mono">（{editing.userDataDir}）</span>
          </p>
          <div className={`${modeGroupCls} mt-2`} role="group" aria-label="实例文件方式">
            <button
              type="button"
              aria-pressed={profileMode === "rename"}
              disabled={editingActive}
              className={modeButtonCls(profileMode === "rename")}
              onClick={() => onModeChange("rename", profileFolderOf(editing))}
            >
              自定
            </button>
            <button
              type="button"
              aria-pressed={profileMode === "swap"}
              disabled={editingActive}
              className={modeButtonCls(profileMode === "swap")}
              onClick={() => onModeChange("swap", "")}
            >
              选择
            </button>
          </div>
          {profileMode === "rename" && (
            <input
              className={`${inputCls} mt-2`}
              value={profileName}
              disabled={editingActive}
              onChange={(e) => onProfileNameChange(e.target.value)}
              placeholder="新的实例文件名称"
            />
          )}
          {profileMode === "swap" && (
            <div className="mt-2">{profilePickerBox(editingActive)}</div>
          )}
          {editingActive && (
            <p className="mt-2 text-xs text-(--text-faint)">
              {editingUnknown
                ? "实例运行状态无法确认时，不能更换实例文件；实例名称与内核可以修改。"
                : "实例运行中，不能更换内核或实例文件。"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
