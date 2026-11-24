// Shared helpers for the proxy page and its extracted components.
// Pure functions/constants — no React, no services.
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 用户在系统文件选择器中取消选择时，后端以「未选择文件」
// 返回。这不是错误：静默结束，不显示任何提示。
export const PICKER_CANCELLED = "未选择文件";
