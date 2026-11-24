// Instance-file picker for the create/edit form: the options are
// fetched fresh at open time (never the form-open cache), exactly
// one may be picked, and nothing is applied until 「选择」
// confirms. Owns only the picker state; the form dialog keeps
// rendering the picker from these values.
/** @jsxRuntime automatic */
import { useState } from "react";
import { InstanceService } from "../../bindings/github.com/KPP69/DeBrowser/internal/service";
import type { ProfilePickerState } from "../components/instances/ProfilePickerDialog";

export interface ProfilePicker {
  profilePicker: ProfilePickerState | null;
  setProfilePicker: (next: ProfilePickerState | null) => void;
  pickerBusy: boolean;
  profileNote: string | null;
  setProfileNote: (next: string | null) => void;
  appliedProfileName: string | null;
  setAppliedProfileName: (next: string | null) => void;
  openProfilePicker: (currentProfileName: string) => Promise<void>;
  confirmProfilePicker: () => void;
}

export function useProfilePicker(formOpen: boolean): ProfilePicker {
  const [profilePicker, setProfilePicker] = useState<ProfilePickerState | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [appliedProfileName, setAppliedProfileName] = useState<string | null>(null);

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

  return {
    profilePicker,
    setProfilePicker,
    pickerBusy,
    profileNote,
    setProfileNote,
    appliedProfileName,
    setAppliedProfileName,
    openProfilePicker,
    confirmProfilePicker,
  };
}
