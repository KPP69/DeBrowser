package service

// Instance -> node bindings and listener port allocation.

import (
	"context"
	"errors"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/mihomo"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/store"
)

const (
	proxyListenerBase = 21001
	proxyListenerSpan = 1000
)

func (s *ProxyService) ListBindings() ([]BindingView, error) {
	ctx := context.Background()
	bindings, err := s.store.ListProxyBindings(ctx)
	if err != nil {
		return nil, err
	}
	nodes, err := s.store.ListProxyNodes(ctx)
	if err != nil {
		return nil, err
	}
	sources, err := s.store.ListProxySources(ctx)
	if err != nil {
		return nil, err
	}
	nodeByID := map[string]model.ProxyNode{}
	for _, n := range nodes {
		nodeByID[n.ID] = n
	}
	srcName := map[string]string{}
	for _, src := range sources {
		srcName[src.ID] = src.Name
	}
	out := make([]BindingView, 0, len(bindings))
	for _, b := range bindings {
		v := BindingView{InstanceID: b.InstanceID, NodeID: b.NodeID, ListenPort: b.ListenPort}
		if n, ok := nodeByID[b.NodeID]; ok {
			v.NodeName = n.Name
			v.SourceName = srcName[n.SourceID]
		}
		out = append(out, v)
	}
	return out, nil
}

// --- bindings ---

// allocatePortLocked picks the lowest free listener port: not
// held by another binding and not answering on loopback.
func (s *ProxyService) allocatePortLocked(ctx context.Context) (int, error) {
	used, err := s.store.UsedProxyPorts(ctx)
	if err != nil {
		return 0, err
	}
	for p := proxyListenerBase; p < proxyListenerBase+proxyListenerSpan; p++ {
		if used[p] {
			continue
		}
		if mihomo.ProbePort(p) {
			continue
		}
		return p, nil
	}
	return 0, fmt.Errorf("没有可用的代理监听端口")
}

// SetBinding binds an instance to a node (or moves it to a new
// node). An existing binding keeps its listener port; a new
// binding gets a fresh allocation. This is the single binding
// write both pages use.
func (s *ProxyService) SetBinding(operationID, instanceID, nodeID string) (BindingView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.binding_set", "instance", instanceID)
	view, err := s.setBinding(instanceID, nodeID)
	finishOp(op, err)
	return view, err
}

func (s *ProxyService) setBinding(instanceID, nodeID string) (BindingView, error) {
	ctx := context.Background()
	if _, err := s.store.GetInstance(ctx, instanceID); err != nil {
		return BindingView{}, fmt.Errorf("实例不存在")
	}
	node, err := s.store.GetProxyNode(ctx, nodeID)
	if err != nil {
		return BindingView{}, fmt.Errorf("代理节点不存在")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	port := 0
	if existing, err := s.store.GetProxyBinding(ctx, instanceID); err == nil {
		port = existing.ListenPort
	} else if errors.Is(err, store.ErrNotFound) {
		p, err := s.allocatePortLocked(ctx)
		if err != nil {
			return BindingView{}, err
		}
		port = p
	} else {
		return BindingView{}, fmt.Errorf("读取实例现有代理绑定失败，已中止设置：%w", err)
	}
	if err := s.store.UpsertProxyBinding(ctx, model.InstanceProxyBinding{
		InstanceID: instanceID, NodeID: nodeID, ListenPort: port,
	}); err != nil {
		return BindingView{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return BindingView{}, err
	}
	srcName := ""
	if src, err := s.store.GetProxySource(ctx, node.SourceID); err == nil {
		srcName = src.Name
	}
	return BindingView{
		InstanceID: instanceID, NodeID: nodeID, NodeName: node.Name,
		SourceName: srcName, ListenPort: port,
	}, nil
}

// ClearBinding removes an instance's binding (the instance
// connects directly afterwards). Clearing an unbound instance
// is a no-op.
func (s *ProxyService) ClearBinding(operationID, instanceID string) error {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.binding_clear", "instance", instanceID)
	err := s.clearBinding(instanceID)
	finishOp(op, err)
	return err
}

func (s *ProxyService) clearBinding(instanceID string) error {
	ctx := context.Background()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.DeleteProxyBinding(ctx, instanceID); err != nil {
		return err
	}
	return s.reloadLocked(ctx)
}

// ProxyPortForInstance is the instance launch hook wired in
// main: it returns the loopback port the starting instance
// must use as its proxy, 0 for a direct connection, or an
// error refusing the launch when the instance is bound but
// the core cannot serve the binding right now. A bound
// instance never silently falls back to direct.
func (s *ProxyService) ProxyPortForInstance(instanceID string) (int, error) {
	ctx := context.Background()
	b, err := s.store.GetProxyBinding(ctx, instanceID)
	if errors.Is(err, store.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("读取实例代理绑定失败：%w", err)
	}
	instName := instanceID
	if inst, err := s.store.GetInstance(ctx, instanceID); err == nil {
		instName = inst.Name
	}
	s.mu.Lock()
	running := false
	if err := s.initCoreLocked(); err == nil {
		running = s.coreRunningLocked()
	}
	s.mu.Unlock()
	if !running {
		return 0, fmt.Errorf("实例「%s」已绑定代理节点，但代理核心未启动；请先在代理配置页面启动核心，或取消该实例的代理绑定", instName)
	}
	if !mihomo.ProbeListener(b.ListenPort) {
		return 0, fmt.Errorf("实例「%s」的代理监听端口 %d 未就绪，请重启代理核心后重试", instName, b.ListenPort)
	}
	return b.ListenPort, nil
}
