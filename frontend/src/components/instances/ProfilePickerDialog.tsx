// Instance-file picker dialog for the instances page. Props only —
// the page keeps the picker state and the open/confirm logic; this
// component only renders the option list above the form
// (DialogLayer zIndex 20). Nothing is applied until 「选择」
// confirms.
/** @jsxRuntime automatic */
import { DialogLayer } from "../Modal";
import type { ProfileDirInfo } from "../../../bindings/github.com/KPP69/DeBrowser/internal/model";

// The instance-file picker dialog: the options are fetched fresh
// at open time (never the form-open cache), exactly one may be
// picked, and nothing is applied until 「选择」 confirms.
export interface ProfilePickerState {
  options: ProfileDirInfo[];
  picked: string;
}

export interface ProfilePickerDialogProps {
  picker: ProfilePickerState | null;
  onPick: (name: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ProfilePickerDialog({
  picker,
  onPick,
  onConfirm,
  onCancel,
}: ProfilePickerDialogProps) {
  if (!picker) return null;
  return (
    <DialogLayer open onClose={onCancel} zIndex={20}>
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-(--border) bg-(--panel-bg) p-5 shadow-xl">
        <h3 className="text-base font-semibold">选择实例文件</h3>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-(--border)">
          {picker.options.map((p) => (
            <button
              key={p.name}
              type="button"
              aria-pressed={picker.picked === p.name}
              onClick={() => onPick(p.name)}
              className={`block w-full px-3 py-2 text-left hover:bg-(--hover-bg) ${
                picker.picked === p.name ? "bg-(--hover-bg)" : ""
              }`}
            >
              <span className="text-sm font-medium text-(--text-main)">{p.name}</span>
              <span className="block truncate text-xs text-(--text-faint)">{p.path}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-(--border) px-3 py-1.5 text-sm text-(--text-dim) hover:bg-(--hover-bg)"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!picker.picked}
            onClick={onConfirm}
            className="rounded-md bg-(--accent) px-3 py-1.5 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:opacity-50"
          >
            选择
          </button>
        </div>
      </div>
    </DialogLayer>
  );
}
