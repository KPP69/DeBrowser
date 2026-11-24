import { useEffect, useRef, type ReactNode } from "react";

/**
 * 弹窗统一行为：Esc 关闭、Tab 焦点循环、打开时聚焦首个元素
 * （或带 data-autofocus 的元素）、关闭后把焦点还给触发元素。
 * 输入框内按 Enter 触发 onSubmit；文本域和按钮不拦截。
 */
export function useDialogBehavior(
  open: boolean,
  containerRef: { current: HTMLElement | null },
  onClose: () => void,
  onSubmit?: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = containerRef.current;
    if (!panel) return;
    const focusables = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
    const first = panel.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0];
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter" && onSubmit) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag !== "TEXTAREA" && tag !== "BUTTON" && tag !== "A") {
          e.preventDefault();
          onSubmit();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, containerRef, onClose, onSubmit]);
}

/**
 * 弹窗遮罩层：只负责遮罩、点击外部关闭与键盘行为，
 * 面板内容与样式由调用方提供（便于逐步替换旧弹窗）。
 */
export function DialogLayer({
  open,
  onClose,
  onSubmit,
  zIndex = 10,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit?: () => void;
  zIndex?: number;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  useDialogBehavior(open, layerRef, onClose, onSubmit);
  if (!open) return null;
  return (
    <div
      ref={layerRef}
      style={{ zIndex }}
      className="fixed inset-0 flex items-center justify-center bg-(--overlay) px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** 带标题与页脚的弹窗。 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  labelledBy,
  hideTitle = false,
  onSubmit,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
  hideTitle?: boolean;
  onSubmit?: () => void;
}) {
  const titleId = labelledBy ?? "modal-title";
  return (
    <DialogLayer open={open} onClose={onClose} onSubmit={onSubmit}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={hideTitle ? undefined : titleId}
        className="w-full max-w-md rounded-xl border border-(--border) bg-(--panel-bg) p-5 shadow-xl"
      >
        {!hideTitle && (
          <h3 id={titleId} className="text-base font-semibold">
            {title}
          </h3>
        )}
        <div className={hideTitle ? "" : "mt-3"}>{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </DialogLayer>
  );
}

/** 统一确认弹窗：动词 + 对象、影响说明、数量、危险色。 */
export function ConfirmDialog({
  open,
  title,
  impact,
  count,
  countLabel,
  details,
  note,
  confirmLabel,
  cancelLabel = "取消",
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  impact: string;
  count?: number;
  countLabel?: string;
  details?: ReactNode;
  note?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? () => undefined : onCancel}
      labelledBy="confirm-dialog-title"
      footer={
        <>
          <button
            type="button"
            data-autofocus
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-(--border) px-3 py-1.5 text-sm text-(--text-dim) hover:bg-(--hover-bg) disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              danger
                ? "rounded-md bg-(--danger) px-3 py-1.5 text-sm font-medium text-(--danger-contrast) hover:opacity-90 disabled:opacity-50"
                : "rounded-md bg-(--accent) px-3 py-1.5 text-sm font-medium text-(--accent-contrast) hover:opacity-90 disabled:opacity-50"
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-(--text-dim)">{impact}</p>
      {count !== undefined && (
        <p className="mt-2 text-sm text-(--text-main)">
          数量：{count} {countLabel ?? ""}
        </p>
      )}
      {details}
      {note && <p className="mt-2 text-xs text-(--text-faint)">{note}</p>}
    </Modal>
  );
}

/** 表单类弹窗：沿用 Modal 的键盘/焦点行为，标题由内容自带。 */
export function Dialog({
  open,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
}) {
  return (
    <Modal open={open} title="" hideTitle onClose={onClose} onSubmit={onSubmit}>
      {children}
    </Modal>
  );
}
