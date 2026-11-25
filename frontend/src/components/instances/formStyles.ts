// Shared form class constants for the instances page dialogs
// (form + batch create). Pure strings — no React, no services.
export const inputCls =
  "w-full rounded-md border border-(--border) bg-(--input-bg) px-2.5 py-1.5 text-sm text-(--text-main) outline-none placeholder:text-(--text-faint) disabled:opacity-50";

export const labelCls = "mb-1 block text-xs text-(--text-dim)";

export const modeGroupCls = "inline-flex overflow-hidden rounded-md border border-(--border-strong)";

export const modeButtonCls = (active: boolean) =>
  `h-8 px-3.5 text-sm transition-colors ${
    active
      ? "bg-(--accent) font-medium text-(--accent-contrast)"
      : "bg-(--input-bg) text-(--text-dim) hover:bg-(--hover-bg)"
  } disabled:cursor-not-allowed disabled:opacity-50`;
