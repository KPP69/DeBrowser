// The outcome of one batch operation goes to the global
// notification system as ONE summary notification; the
// per-item results (succeeded / skipped with reason / failed
// with reason) ride along as expandable items in the
// notification center. Partial success is reported as partial.
import { notify } from "../stores/useNotificationStore";
import { classifyCounts } from "./operationResult";
import type { NotificationItem } from "./notifications";

export function notifyBatchResult(
  title: string,
  okNames: string[],
  skipped: { name: string; reason: string }[],
  failed: { name: string; reason: string }[],
): void {
  const items: NotificationItem[] = [
    ...okNames.map((name) => ({ name, status: "success" as const })),
    ...skipped.map((it) => ({ name: it.name, status: "skipped" as const, reason: it.reason })),
    ...failed.map((it) => ({ name: it.name, status: "failed" as const, reason: it.reason })),
  ];
  const summary =
    `${title}：成功 ${okNames.length} 个` +
    (skipped.length > 0 ? `，跳过 ${skipped.length} 个` : "") +
    (failed.length > 0 ? `，失败 ${failed.length} 个` : "");
  const kind = classifyCounts(okNames.length, failed.length, skipped.length);
  if (kind !== null) notify(kind, summary, { items, important: true });
}
