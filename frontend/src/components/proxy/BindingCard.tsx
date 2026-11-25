// 下方绑定区：左右并排的代理节点卡片与实例列表卡片，等高，
// 各自内部纵向滚动（无分页），窗口较窄时上下排列。
// 只收 props 渲染，不调用任何 Service：测速与绑定切换都由
// 页面编排；节点测速结果只用于本页显示，不保存。
/** @jsxRuntime automatic */
import { Gauge, Loader2 } from "lucide-react";
import type { Instance } from "../../../bindings/github.com/KPP69/DeBrowser/internal/model";
import type {
  BindingView,
  NodeTestResultView,
  NodeView,
} from "../../../bindings/github.com/KPP69/DeBrowser/internal/service";
import ProxyNodePicker from "../ProxyNodePicker";
import { btnSmall } from "./proxyStyles";

export interface BindingCardProps {
  nodes: NodeView[];
  testResults: Record<string, NodeTestResultView>;
  testing: boolean;
  // 页面正忙（任意操作进行中）：测速与节点选择禁用。
  disabled: boolean;
  onTest: () => void;
  instances: Instance[];
  bindingByInstance: Map<string, BindingView>;
  onChangeBinding: (instance: Instance, nodeId: string) => void;
}

export default function BindingCard({
  nodes,
  testResults,
  testing,
  disabled,
  onTest,
  instances,
  bindingByInstance,
  onChangeBinding,
}: BindingCardProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 min-[1150px]:flex-row">
      {/* 代理节点卡片：标题栏（标题 + 测速）固定，
          只有节点列表滚动。 */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--panel-bg)">
        <div className="flex shrink-0 items-center gap-3 border-b border-(--border) px-4 py-2.5">
          <h3 className="min-w-0 flex-1 text-[15px] font-semibold">代理节点</h3>
          <button
            type="button"
            className={`${btnSmall} w-20 shrink-0 justify-center`}
            disabled={testing || disabled || nodes.length === 0}
            onClick={onTest}
          >
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Gauge size={13} />}
            测速
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {nodes.length === 0 ? (
            <p className="py-1 text-sm text-(--text-faint)">暂无节点。</p>
          ) : (
            <div>
              {nodes.map((n) => {
                const result = testResults[n.id];
                return (
                  <div key={n.id} className="flex items-center gap-2 border-b border-(--border) py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-sm">{n.name}</span>
                    {result ? (
                      result.ok ? (
                        <span className="shrink-0 text-xs text-(--accent)">{result.delayMs} ms</span>
                      ) : (
                        <span className="shrink-0 text-xs text-(--danger)">不可用</span>
                      )
                    ) : (
                      <span className="shrink-0 text-xs text-(--text-faint)">未测试</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* 实例列表卡片：标题固定，实例行内部滚动。 */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--panel-bg)">
        <h3 className="shrink-0 border-b border-(--border) px-4 py-2.5 text-[15px] font-semibold">实例列表</h3>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {instances.length === 0 ? (
            <p className="py-1 text-sm text-(--text-faint)">尚未创建任何浏览器实例。</p>
          ) : (
            <div>
              {instances.map((inst) => {
                const binding = bindingByInstance.get(inst.id);
                return (
                  <div key={inst.id} className="flex items-center gap-3 border-b border-(--border) py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{inst.name}</span>
                    <div className="w-56 shrink-0">
                      <ProxyNodePicker
                        nodes={nodes}
                        value={binding?.nodeId ?? ""}
                        disabled={disabled}
                        onChange={(nodeId) => onChangeBinding(inst, nodeId)}
                        ariaLabel={`实例 ${inst.name} 的代理节点`}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-xs text-(--text-faint)">
                      {binding ? `端口 ${binding.listenPort}` : "未设置"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
