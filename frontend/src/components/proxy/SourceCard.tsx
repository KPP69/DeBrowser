// 代理源卡片：独占一行；标题与表头固定，数据行内部纵向
// 滚动（无分页）。只收 props 渲染，不调用任何 Service；
// 更新与删除都由页面编排，删除只发出请求、确认弹窗在页面。
/** @jsxRuntime automatic */
import { RefreshCw, Trash2 } from "lucide-react";
import type { SourceView } from "../../../bindings/github.com/KPP69/DeBrowser/internal/service";
import { btnSmall } from "./proxyStyles";

export interface SourceCardProps {
  sources: SourceView[];
  // 页面正忙（任意操作进行中）：更新 / 删除按钮禁用。
  disabled: boolean;
  onRefresh: (source: SourceView) => void;
  onRequestDelete: (source: SourceView) => void;
}

export default function SourceCard({ sources, disabled, onRefresh, onRequestDelete }: SourceCardProps) {
  return (
    <section className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--panel-bg)">
      <h3 className="shrink-0 border-b border-(--border) px-4 py-2.5 text-[15px] font-semibold">代理源</h3>
      {sources.length === 0 ? (
        <p className="px-4 py-3 text-sm text-(--text-faint)">尚未添加任何代理配置。点击右上方「添加」导入订阅或本地配置文件。</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem_5.5rem_5rem_10rem] items-center gap-2 border-b border-(--border) px-4 py-2 text-center text-xs text-(--text-faint)">
            <span>名称</span>
            <span>节点数</span>
            <span>来源</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          <div className="max-h-40 overflow-y-auto px-4">
            {sources.map((src) => (
              <div
                key={src.id}
                className="grid grid-cols-[minmax(0,1fr)_5rem_5.5rem_5rem_10rem] items-center gap-2 border-b border-(--border) py-2 text-center last:border-b-0"
              >
                <span className="truncate text-sm font-medium" title={src.name}>
                  {src.name}
                </span>
                <span className="text-sm">{src.nodeCount} 个</span>
                <span className="text-sm">{src.kind === "subscription" ? "订阅" : "本地文件"}</span>
                <span className="text-sm">{src.nodeCount > 0 ? "正常" : "无节点"}</span>
                <span className="flex items-center justify-center gap-1.5">
                  <button type="button" className={btnSmall} disabled={disabled} onClick={() => onRefresh(src)}>
                    <RefreshCw size={12} />
                    更新
                  </button>
                  <button type="button" className={btnSmall} disabled={disabled} onClick={() => onRequestDelete(src)}>
                    <Trash2 size={12} />
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
          </div>
        </div>
      )}
    </section>
  );
}
