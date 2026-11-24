package service

// ProxyService is the redesigned proxy module: one Mihomo core,
// imported configuration sources (subscriptions and local
// files), the nodes parsed out of them, and the one
// authoritative instance -> node binding shared by the proxy
// page and the instance pages.
//
// The design is deliberately small:
//   - Import parses the source's `proxies:` list in Go and
//     stores each node's definition in the database; the node
//     list is therefore plain data, available whether or not
//     the core runs.
//   - The generated core configuration is just every node plus
//     one loopback listener per binding, each listener naming
//     its instance's node via the core's native per-listener
//     `proxy:` selection. No rules, no groups, no providers.
//   - The database is authoritative. Changes made while the
//     core runs are pushed by regenerating the configuration
//     and asking the core to reload; a reload failure is
//     reported (the change stays, and the launch gate's live
//     probe keeps any unserved binding from being used).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/database"
	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/mihomo"
	"github.com/KPP69/DeBrowser/internal/paths"
	"github.com/KPP69/DeBrowser/internal/secrets"
	"github.com/KPP69/DeBrowser/internal/store"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	proxyControllerPort = 19097
	// Node connectivity test: one fixed public target, one
	// fixed timeout, a small fixed parallelism. No settings —
	// the test answers "can this node connect right now".
	nodeTestURL       = "http://www.gstatic.com/generate_204"
	nodeTestTimeoutMs = 5000
)

// ProxyService runs the proxy module. Its exported methods are
// the Wails-bound API used by the proxy page and the instance
// pages alike.
type ProxyService struct {
	store  *store.Store
	layout paths.Layout
	log    *slog.Logger
	vault  *secrets.Store

	// nodeProtector encrypts node definitions at rest (DPAPI on
	// Windows). nil means no protector is available: definitions are
	// then kept as before rather than failing the whole module.
	nodeProtector secrets.Protector

	// Auditor, when set, receives one operation-audit record
	// per user-initiated mutation (Stage 5B pattern).
	Auditor *logging.System

	// SourceFilePicker supplies the local file for AddFileSource
	// (wired to the native dialog in internal/app; a field so
	// the service layer stays GUI-free and testable).
	SourceFilePicker func() (string, error)

	mu      sync.Mutex
	manager *mihomo.Manager
	secret  string

	// fetchSubscription downloads a subscription body; a field
	// so tests can serve fixtures without a network.
	fetchSubscription func(ctx context.Context, rawURL string) ([]byte, error)

	// delayNode measures one node's delay through the running
	// core; a field so tests can fake the core's answers.
	delayNode func(ctx context.Context, coreName string) (int, error)
}

func NewProxyService(db *database.DB, layout paths.Layout, vault *secrets.Store, log *slog.Logger) *ProxyService {
	s := &ProxyService{
		store:             store.New(db),
		layout:            layout,
		log:               log,
		vault:             vault,
		fetchSubscription: fetchSubscriptionHTTP,
	}
	s.delayNode = func(ctx context.Context, coreName string) (int, error) {
		return s.client().Delay(ctx, coreName, nodeTestURL, nodeTestTimeoutMs)
	}
	if prot, err := secrets.NewProtector(filepath.Join(layout.Data, "node-config.key")); err != nil {
		s.log.Warn("proxy: node definition protection unavailable", "error", err)
	} else {
		s.nodeProtector = prot
		s.sealLegacyNodeConfigs(context.Background())
	}
	return s
}

// ServiceShutdown stops the managed core when DeBrowser exits.
// Browsers the user started are not touched — only the core
// process DeBrowser itself started.
func (s *ProxyService) ServiceShutdown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.manager == nil {
		return nil
	}
	return s.manager.Stop()
}

// --- views ---

// CoreStatusView is the core's state for the page header.
type CoreStatusView struct {
	Running bool   `json:"running"`
	Version string `json:"version"`
	Message string `json:"message"`
}

// SourceView is one imported source plus its node count.
type SourceView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	NodeCount int    `json:"nodeCount"`
	CreatedAt string `json:"createdAt"`
}

// NodeView is one node for the node list; the source name rides
// along so same-named nodes from different sources stay
// distinguishable.
type NodeView struct {
	ID         string `json:"id"`
	SourceID   string `json:"sourceId"`
	SourceName string `json:"sourceName"`
	Name       string `json:"name"`
	Type       string `json:"type"`
}

// BindingView is one instance's binding for display: the node
// it uses and the listener port dedicated to it.
type BindingView struct {
	InstanceID string `json:"instanceId"`
	NodeID     string `json:"nodeId"`
	NodeName   string `json:"nodeName"`
	SourceName string `json:"sourceName"`
	ListenPort int    `json:"listenPort"`
}

// NodeTestResultView is one node's connectivity test outcome:
// OK with the measured delay, or not OK (unreachable or timed
// out). Results are display data only — nothing is persisted.
type NodeTestResultView struct {
	NodeID  string `json:"nodeId"`
	OK      bool   `json:"ok"`
	DelayMs int    `json:"delayMs"`
}

// --- core lifecycle ---

func (s *ProxyService) initCoreLocked() error {
	if err := os.MkdirAll(s.layout.Mihomo, 0o750); err != nil {
		return fmt.Errorf("创建代理核心目录失败：%w", err)
	}
	if s.secret == "" {
		secretPath := filepath.Join(s.layout.Mihomo, "controller-secret.txt")
		if data, err := os.ReadFile(secretPath); err == nil && len(strings.TrimSpace(string(data))) >= 16 {
			s.secret = strings.TrimSpace(string(data))
		} else {
			buf := make([]byte, 24)
			if _, err := rand.Read(buf); err != nil {
				return err
			}
			s.secret = hex.EncodeToString(buf)
			if err := os.WriteFile(secretPath, []byte(s.secret), 0o600); err != nil {
				return fmt.Errorf("保存核心控制密钥失败：%w", err)
			}
		}
	}
	if s.manager == nil {
		s.manager = mihomo.NewManager(s.layout.Mihomo)
	}
	return nil
}

func (s *ProxyService) client() *mihomo.Client {
	return mihomo.NewClient(proxyControllerPort, s.secret)
}

// coreRunningLocked reports whether DeBrowser's own core is up
// and answering with the shared secret.
func (s *ProxyService) coreRunningLocked() bool {
	if s.manager == nil || !s.manager.Running() {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return s.client().Version(ctx) == nil
}

// GetCoreStatus reports the core's state. A core process that
// is running but not answering is reported as an error state,
// never as "running".
func (s *ProxyService) GetCoreStatus() CoreStatusView {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.initCoreLocked(); err != nil {
		return CoreStatusView{Message: err.Error()}
	}
	if s.coreRunningLocked() {
		return CoreStatusView{Running: true, Version: mihomo.CoreVersion}
	}
	if s.manager.Running() {
		msg := "代理核心进程在运行但没有响应"
		if werr := s.manager.WaitErr(); werr != nil {
			msg = fmt.Sprintf("代理核心已退出：%v", werr)
		}
		return CoreStatusView{Version: mihomo.CoreVersion, Message: msg}
	}
	// Not ours, but something answers with our secret? Cannot
	// happen (the secret is private to this installation). If
	// the port is occupied by a foreign program, starting will
	// say so; the stopped state stays plain.
	return CoreStatusView{Version: mihomo.CoreVersion}
}

// StartCore generates the configuration from the current
// database state and starts the core.
func (s *ProxyService) StartCore(operationID string) (CoreStatusView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.core_start", "proxy_core", "")
	s.mu.Lock()
	defer s.mu.Unlock()
	var view CoreStatusView
	err := func() error {
		if err := s.initCoreLocked(); err != nil {
			return err
		}
		if s.coreRunningLocked() {
			view = CoreStatusView{Running: true, Version: mihomo.CoreVersion}
			return nil
		}
		if err := s.regenerateLocked(context.Background()); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if err := s.manager.Start(ctx, proxyControllerPort, s.client()); err != nil {
			return err
		}
		view = CoreStatusView{Running: true, Version: mihomo.CoreVersion}
		return nil
	}()
	finishOp(op, err)
	if err != nil {
		return CoreStatusView{Version: mihomo.CoreVersion, Message: err.Error()}, err
	}
	return view, nil
}

// StopCore stops the managed core.
func (s *ProxyService) StopCore(operationID string) (CoreStatusView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.core_stop", "proxy_core", "")
	s.mu.Lock()
	defer s.mu.Unlock()
	var err error
	if s.manager != nil {
		err = s.manager.Stop()
	}
	finishOp(op, err)
	if err != nil {
		return CoreStatusView{Version: mihomo.CoreVersion, Message: err.Error()}, err
	}
	return CoreStatusView{Version: mihomo.CoreVersion}, nil
}

// --- configuration generation ---

func coreNodeName(nodeID string) string { return "n-" + nodeID }

func (s *ProxyService) configPath() string {
	return filepath.Join(s.layout.Mihomo, "config.yaml")
}

func (s *ProxyService) sourcesDir() string {
	return filepath.Join(s.layout.Mihomo, "sources")
}

// regenerateLocked rewrites the core configuration from the
// database. Callers hold s.mu.
func (s *ProxyService) regenerateLocked(ctx context.Context) error {
	nodes, err := s.store.ListProxyNodes(ctx)
	if err != nil {
		return err
	}
	bindings, err := s.store.ListProxyBindings(ctx)
	if err != nil {
		return err
	}
	defs := make([]mihomo.NodeDef, 0, len(nodes))
	for _, n := range nodes {
		plain, err := s.unprotectNodeConfig(n.ConfigJSON)
		if err != nil {
			return fmt.Errorf("节点「%s」的配置数据损坏：%w", n.Name, err)
		}
		var cfg map[string]any
		if err := json.Unmarshal(plain, &cfg); err != nil {
			return fmt.Errorf("节点「%s」的配置数据损坏：%w", n.Name, err)
		}
		defs = append(defs, mihomo.NodeDef{CoreName: coreNodeName(n.ID), Config: cfg})
	}
	bdefs := make([]mihomo.BindingDef, 0, len(bindings))
	for _, b := range bindings {
		bdefs = append(bdefs, mihomo.BindingDef{Port: b.ListenPort, NodeCoreName: coreNodeName(b.NodeID)})
	}
	content := mihomo.Generate(defs, bdefs, proxyControllerPort, s.secret)
	if err := os.MkdirAll(s.layout.Mihomo, 0o750); err != nil {
		return err
	}
	tmp := s.configPath() + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o640); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.configPath()); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// reloadLocked regenerates the configuration and, when the core
// is running, asks it to reload. Callers hold s.mu.
func (s *ProxyService) reloadLocked(ctx context.Context) error {
	if err := s.regenerateLocked(ctx); err != nil {
		return err
	}
	if !s.coreRunningLocked() {
		return nil
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := s.client().ReloadConfig(rctx, s.configPath()); err != nil {
		return fmt.Errorf("核心重载配置失败（修改已保存，重启代理核心后生效）：%w", err)
	}
	return nil
}

// --- source import ---
