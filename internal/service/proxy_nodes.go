package service

// Proxy node parsing, listing, testing and at-rest encryption.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"gopkg.in/yaml.v3"
	"strings"
	"sync"
	"time"
)

const (
	proxyMaxNodes = 2000
	// nodeConfigSecretPrefix marks a node definition that is stored
	// encrypted at rest. Node definitions carry passwords, UUIDs and
	// private keys; the database must not hold them in plain text.
	nodeConfigSecretPrefix = "dpapi:v1:"
	nodeTestConcurrency    = 8
)

// protectNodeConfig encrypts one node definition for storage.
func (s *ProxyService) protectNodeConfig(plain []byte) (string, error) {
	if s.nodeProtector == nil {
		return string(plain), nil
	}
	blob, err := s.nodeProtector.Protect(plain)
	if err != nil {
		return "", fmt.Errorf("加密节点配置失败：%w", err)
	}
	return nodeConfigSecretPrefix + base64.StdEncoding.EncodeToString(blob), nil
}

// unprotectNodeConfig returns a node definition's plain JSON. A value
// without the prefix is a legacy plaintext row and is returned as-is.
func (s *ProxyService) unprotectNodeConfig(stored string) ([]byte, error) {
	if !strings.HasPrefix(stored, nodeConfigSecretPrefix) {
		return []byte(stored), nil
	}
	if s.nodeProtector == nil {
		return nil, fmt.Errorf("节点配置已加密，但当前环境无法解密")
	}
	blob, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, nodeConfigSecretPrefix))
	if err != nil {
		return nil, fmt.Errorf("节点配置密文损坏：%w", err)
	}
	plain, err := s.nodeProtector.Unprotect(blob)
	if err != nil {
		return nil, fmt.Errorf("节点配置无法解密（可能来自其他 Windows 用户或机器）")
	}
	return plain, nil
}

// sealLegacyNodeConfigs rewrites rows written before node definitions
// were encrypted. A failure only leaves that row as it was; it never
// blocks startup.
func (s *ProxyService) sealLegacyNodeConfigs(ctx context.Context) {
	if s.nodeProtector == nil {
		return
	}
	nodes, err := s.store.ListProxyNodes(ctx)
	if err != nil {
		s.log.Warn("proxy: list nodes for sealing failed", "error", err)
		return
	}
	for _, n := range nodes {
		if strings.HasPrefix(n.ConfigJSON, nodeConfigSecretPrefix) {
			continue
		}
		sealed, err := s.protectNodeConfig([]byte(n.ConfigJSON))
		if err != nil {
			s.log.Warn("proxy: seal node definition failed", "node", n.ID, "error", err)
			continue
		}
		if err := s.store.UpdateProxyNodeConfig(ctx, n.ID, sealed); err != nil {
			s.log.Warn("proxy: store sealed node definition failed", "node", n.ID, "error", err)
		}
	}
}

type parsedNode struct {
	name string
	cfg  map[string]any
}

// parseProxyNodes extracts the node list from a Clash/Mihomo
// YAML document (a full configuration or a proxies-only file —
// both carry the nodes under the same top-level `proxies:`).
// URI-list / Base64 subscription formats are rejected with a
// specific message: the core cannot use them either.
func parseProxyNodes(data []byte) ([]parsedNode, error) {
	if looksLikeURIList(data) {
		return nil, fmt.Errorf("该内容是 URI/Base64 格式的订阅，DeBrowser 仅支持 Clash/Mihomo 的 YAML 配置格式")
	}
	var doc struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("配置文件不是有效的 YAML：%w", err)
	}
	if len(doc.Proxies) == 0 {
		return nil, fmt.Errorf("配置中没有找到代理节点（proxies 列表为空或不存在）")
	}
	if len(doc.Proxies) > proxyMaxNodes {
		return nil, fmt.Errorf("配置中的节点数量超过上限（%d）", proxyMaxNodes)
	}
	seen := map[string]bool{}
	out := make([]parsedNode, 0, len(doc.Proxies))
	for _, raw := range doc.Proxies {
		name, _ := raw["name"].(string)
		typ, _ := raw["type"].(string)
		if strings.TrimSpace(name) == "" || strings.TrimSpace(typ) == "" {
			return nil, fmt.Errorf("配置中存在缺少名称或类型的节点，无法导入")
		}
		if seen[name] {
			return nil, fmt.Errorf("配置中存在同名节点「%s」，同一配置内的节点名称必须唯一", name)
		}
		seen[name] = true
		out = append(out, parsedNode{name: name, cfg: raw})
	}
	return out, nil
}

func looksLikeURIList(data []byte) bool {
	text := strings.TrimSpace(string(data))
	if strings.Contains(text, "://") && !strings.Contains(text, "proxies:") {
		return true
	}
	// Base64 blobs decode to URI lists; a YAML document never
	// consists of one long unbroken token.
	if !strings.ContainsAny(text, "\n ") && len(text) > 64 {
		return true
	}
	return false
}

// ListNodes returns every imported node across all sources.
func (s *ProxyService) ListNodes() ([]NodeView, error) {
	ctx := context.Background()
	sources, err := s.store.ListProxySources(ctx)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, src := range sources {
		names[src.ID] = src.Name
	}
	nodes, err := s.store.ListProxyNodes(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]NodeView, 0, len(nodes))
	for _, n := range nodes {
		var cfg map[string]any
		if plain, derr := s.unprotectNodeConfig(n.ConfigJSON); derr == nil {
			_ = json.Unmarshal(plain, &cfg)
		}
		typ, _ := cfg["type"].(string)
		out = append(out, NodeView{
			ID: n.ID, SourceID: n.SourceID, SourceName: names[n.SourceID],
			Name: n.Name, Type: typ,
		})
	}
	return out, nil
}

// ListBindings returns every instance binding with display
// names resolved. This is the single binding read both pages
// use.
// TestNodes runs a one-off connectivity test for the given
// nodes through the running core, using the core's native
// per-proxy delay measurement against one fixed target. It
// only answers when the user clicks 测速 — nothing runs in
// the background — and it changes no data: results go back
// to the caller for display only.
func (s *ProxyService) TestNodes(operationID string, nodeIDs []string) ([]NodeTestResultView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.node_test", "proxy_node", "")
	results, err := s.testNodes(nodeIDs)
	finishOp(op, err)
	return results, err
}

func (s *ProxyService) testNodes(nodeIDs []string) ([]NodeTestResultView, error) {
	results := make([]NodeTestResultView, len(nodeIDs))
	for i, id := range nodeIDs {
		results[i].NodeID = id
	}
	if len(nodeIDs) == 0 {
		return results, nil
	}
	// Snapshot what the tests need, then release the lock:
	// a full run can take seconds and must not stall other
	// proxy operations behind it.
	s.mu.Lock()
	if err := s.initCoreLocked(); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	running := s.coreRunningLocked()
	delay := s.delayNode
	s.mu.Unlock()
	if !running {
		return nil, fmt.Errorf("代理核心未启动，无法测速。请先启动代理核心")
	}
	ctx := context.Background()
	valid := make([]int, 0, len(nodeIDs))
	for i, id := range nodeIDs {
		if _, err := s.store.GetProxyNode(ctx, id); err == nil {
			valid = append(valid, i)
		} // unknown node: result stays not-OK
	}
	runNodeDelayTests(nodeIDs, valid, delay, results)
	return results, nil
}

// runNodeDelayTests measures the delay of the nodes at the
// given result indexes with bounded parallelism and fills
// their results in place.
func runNodeDelayTests(nodeIDs []string, indexes []int, delay func(ctx context.Context, coreName string) (int, error), results []NodeTestResultView) {
	sem := make(chan struct{}, nodeTestConcurrency)
	var wg sync.WaitGroup
	for _, i := range indexes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			tctx, cancel := context.WithTimeout(context.Background(), time.Duration(nodeTestTimeoutMs)*time.Millisecond+5*time.Second)
			defer cancel()
			ms, err := delay(tctx, coreNodeName(nodeIDs[i]))
			if err == nil {
				results[i].OK = true
				results[i].DelayMs = ms
			}
		}(i)
	}
	wg.Wait()
}
