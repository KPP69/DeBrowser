// 书签页右侧实例列表面板：标题、实例搜索框、全选与实例行复选框。
// 只收 props，不调用任何 Service；实例筛选与选择状态由页面持有。
/** @jsxRuntime automatic */
import { Search } from "lucide-react";
import type { BookmarkInstanceInfo } from "../../../bindings/github.com/KPP69/DeBrowser/internal/service";

export interface BookmarkInstanceListProps {
  filteredInstances: BookmarkInstanceInfo[];
  instSelected: ReadonlySet<string>;
  instQuery: string;
  // 由页面传入（与其它书签组件保持一致的 props 形状）；本面板的
  // 选择在忙碌时仍可用，与原页面行为一致，故此处不用于禁用。
  busy: boolean;
  onInstQueryChange: (value: string) => void;
  onToggleInstSelect: (id: string) => void;
  onToggleInstSelectAll: (checked: boolean) => void;
}

export default function BookmarkInstanceList({
  filteredInstances,
  instSelected,
  instQuery,
  onInstQueryChange,
  onToggleInstSelect,
  onToggleInstSelectAll,
}: BookmarkInstanceListProps) {
  return (
    <section className="flex w-72 shrink-0 flex-col rounded-lg border border-(--border) bg-(--panel-bg)">
      <header className="flex items-center gap-2 border-b border-(--border) px-3 py-2">
        <h3 className="text-sm font-semibold">实例列表</h3>
        <label className="ml-auto flex items-center gap-1 rounded-md bg-(--hover-bg) px-2 py-1">
          <Search size={13} className="text-(--text-faint)" />
          <input
            className="w-24 bg-transparent text-xs outline-none"
            placeholder="搜索实例"
            value={instQuery}
            onChange={(e) => onInstQueryChange(e.target.value)}
          />
        </label>
      </header>
      <label className="flex items-center gap-2 border-b border-(--border) px-3 py-1.5 text-xs text-(--text-faint)">
        <input
          type="checkbox"
          checked={filteredInstances.length > 0 && filteredInstances.every((i) => instSelected.has(i.id))}
          onChange={(e) => onToggleInstSelectAll(e.target.checked)}
        />
        全选（当前显示 {filteredInstances.length} 个）
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {filteredInstances.length === 0 ? (
          <p className="px-3 py-4 text-sm text-(--text-faint)">没有实例。</p>
        ) : (
          filteredInstances.map((inst) => (
            <label
              key={inst.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-(--hover-bg)"
            >
              <input
                type="checkbox"
                checked={instSelected.has(inst.id)}
                onChange={() => onToggleInstSelect(inst.id)}
              />
              <span className="min-w-0 flex-1 truncate">{inst.name}</span>
              <span className="text-xs text-(--text-faint)">
                {inst.bookmarkCount >= 0 ? inst.bookmarkCount + " 个书签" : "书签数未知"}
              </span>
            </label>
          ))
        )}
      </div>
    </section>
  );
}
