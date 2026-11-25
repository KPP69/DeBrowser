// Shared class constants for the proxy page (page + extracted cards
// + add dialog). Pure strings — no React, no services.
export const inputCls =
  "w-full rounded-md border border-(--border) bg-(--input-bg) px-2.5 py-1.5 text-sm text-(--text-main) outline-none placeholder:text-(--text-faint) disabled:opacity-50";

export const labelCls = "mb-1 block text-xs text-(--text-dim)";

export const btnPrimary =
  "inline-flex h-9 items-center gap-1.5 rounded-md bg-(--accent) px-3 text-sm font-medium text-(--accent-contrast) transition hover:opacity-90 disabled:opacity-50";

export const btnSecondary =
  "inline-flex h-9 items-center gap-1.5 rounded-md border border-(--border-strong) bg-(--input-bg) px-3 text-sm text-(--text-main) transition hover:bg-(--hover-bg) disabled:opacity-50";

export const btnSmall =
  "inline-flex h-7 items-center gap-1 rounded-md border border-(--border-strong) bg-(--input-bg) px-2 text-xs text-(--text-main) transition hover:bg-(--hover-bg) disabled:opacity-50";
