package service

// Proxy source management: importing subscription and local-file
// sources, refreshing them, and deleting them.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/store"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	proxyMaxSourceBytes = 32 << 20
)

// insertSourceLocked stores a parsed source and its nodes in
// one transaction. Callers hold s.mu and have already arranged
// the vault entry / file copy the row points at.
func (s *ProxyService) insertSourceLocked(ctx context.Context, src model.ProxySource, nodes []parsedNode) error {
	return s.store.WithTx(ctx, func(tx *store.Store) error {
		if err := tx.CreateProxySource(ctx, src); err != nil {
			return err
		}
		for _, n := range nodes {
			id, err := store.NewID()
			if err != nil {
				return err
			}
			cfgJSON, err := json.Marshal(n.cfg)
			if err != nil {
				return err
			}
			config, err := s.protectNodeConfig(cfgJSON)
			if err != nil {
				return err
			}
			if err := tx.CreateProxyNode(ctx, model.ProxyNode{
				ID: id, SourceID: src.ID, Name: n.name, ConfigJSON: config,
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// AddSubscriptionSource downloads a subscription, parses its
// nodes, and only then records anything: a failed download or
// parse leaves no trace. The URL itself is stored exclusively
// in the credential vault.
func (s *ProxyService) AddSubscriptionSource(operationID, name, rawURL string) (SourceView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.source_add_subscription", "proxy_source", "")
	view, err := s.addSubscriptionSource(name, rawURL)
	finishOp(op, err)
	return view, err
}

func (s *ProxyService) addSubscriptionSource(name, rawURL string) (SourceView, error) {
	name = strings.TrimSpace(name)
	rawURL = strings.TrimSpace(rawURL)
	if name == "" {
		return SourceView{}, fmt.Errorf("请填写配置名称")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return SourceView{}, fmt.Errorf("订阅地址无效，请填写完整的 http/https 地址")
	}
	ctx := context.Background()
	dctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	data, err := s.fetchSubscription(dctx, rawURL)
	cancel()
	if err != nil {
		return SourceView{}, fmt.Errorf("下载订阅失败：%w", err)
	}
	nodes, err := parseProxyNodes(data)
	if err != nil {
		return SourceView{}, fmt.Errorf("解析订阅失败：%w", err)
	}
	if s.vault == nil {
		return SourceView{}, fmt.Errorf("凭据 Vault 不可用，无法保存订阅地址")
	}
	ref, err := s.vault.Put([]byte(rawURL))
	if err != nil {
		return SourceView{}, fmt.Errorf("保存订阅地址到凭据 Vault 失败：%w", err)
	}
	id, err := store.NewID()
	if err != nil {
		_, _ = s.vault.DeleteCompensating(ref)
		return SourceView{}, err
	}
	src := model.ProxySource{ID: id, Name: name, Kind: model.ProxySourceKindSubscription, SecretRef: ref}
	s.mu.Lock()
	err = s.insertSourceLocked(ctx, src, nodes)
	if err != nil {
		s.mu.Unlock()
		_, _ = s.vault.DeleteCompensating(ref)
		return SourceView{}, err
	}
	s.vault.MarkCommitted(ref)
	err = s.reloadLocked(ctx)
	s.mu.Unlock()
	if err != nil {
		// The source is recorded and valid; only the running
		// core did not pick it up yet (reloadLocked's message
		// says exactly that).
		return SourceView{}, err
	}
	return SourceView{ID: id, Name: name, Kind: src.Kind, NodeCount: len(nodes)}, nil
}

// AddFileSource imports a local Clash/Mihomo YAML file chosen
// through the native file dialog. DeBrowser keeps its own copy
// of the file; the original is never modified.
func (s *ProxyService) AddFileSource(operationID, name string) (SourceView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.source_add_file", "proxy_source", "")
	view, err := s.addFileSource(name)
	finishOp(op, err)
	return view, err
}

func (s *ProxyService) addFileSource(name string) (SourceView, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return SourceView{}, fmt.Errorf("请填写配置名称")
	}
	if s.SourceFilePicker == nil {
		return SourceView{}, fmt.Errorf("文件选择不可用")
	}
	path, err := s.SourceFilePicker()
	if err != nil {
		return SourceView{}, fmt.Errorf("选择文件失败：%w", err)
	}
	if path == "" {
		return SourceView{}, fmt.Errorf("未选择文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return SourceView{}, fmt.Errorf("读取文件失败：%w", err)
	}
	if len(data) == 0 {
		return SourceView{}, fmt.Errorf("选择的文件为空")
	}
	if len(data) > proxyMaxSourceBytes {
		return SourceView{}, fmt.Errorf("选择的文件过大（上限 32 MB）")
	}
	nodes, err := parseProxyNodes(data)
	if err != nil {
		return SourceView{}, fmt.Errorf("解析配置文件失败：%w", err)
	}
	id, err := store.NewID()
	if err != nil {
		return SourceView{}, err
	}
	ctx := context.Background()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.sourcesDir(), 0o750); err != nil {
		return SourceView{}, err
	}
	fileName := id + ".yaml"
	tmp := filepath.Join(s.sourcesDir(), fileName+".tmp")
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return SourceView{}, fmt.Errorf("保存配置文件副本失败：%w", err)
	}
	if err := os.Rename(tmp, filepath.Join(s.sourcesDir(), fileName)); err != nil {
		_ = os.Remove(tmp)
		return SourceView{}, fmt.Errorf("保存配置文件副本失败：%w", err)
	}
	src := model.ProxySource{ID: id, Name: name, Kind: model.ProxySourceKindFile, FileName: fileName}
	if err := s.insertSourceLocked(ctx, src, nodes); err != nil {
		_ = os.Remove(filepath.Join(s.sourcesDir(), fileName))
		return SourceView{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return SourceView{}, err
	}
	return SourceView{ID: id, Name: name, Kind: src.Kind, NodeCount: len(nodes)}, nil
}

// RefreshSource re-downloads a subscription and replaces its
// node set. A failed download or parse keeps the old nodes.
// Bindings to nodes that no longer exist are removed with
// them (the database cascades), which the pages then show as
// 未设置.
func (s *ProxyService) RefreshSource(operationID, id string) (SourceView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.source_refresh", "proxy_source", id)
	view, err := s.refreshSource(id)
	finishOp(op, err)
	return view, err
}

// ReimportFileSource is the local-file counterpart of
// RefreshSource: the user picks the (possibly updated) file
// again and its nodes replace the source's current nodes.
// The file is read and parsed completely before anything is
// written, so cancelling the picker or picking an invalid
// file leaves the source exactly as it was.
func (s *ProxyService) ReimportFileSource(operationID, id string) (SourceView, error) {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.source_reimport", "proxy_source", id)
	view, err := s.reimportFileSource(id)
	finishOp(op, err)
	return view, err
}

func (s *ProxyService) reimportFileSource(id string) (SourceView, error) {
	ctx := context.Background()
	src, err := s.store.GetProxySource(ctx, id)
	if err != nil {
		return SourceView{}, fmt.Errorf("配置不存在")
	}
	if src.Kind != model.ProxySourceKindFile {
		return SourceView{}, fmt.Errorf("订阅请使用「更新」在线刷新")
	}
	if s.SourceFilePicker == nil {
		return SourceView{}, fmt.Errorf("文件选择不可用")
	}
	path, err := s.SourceFilePicker()
	if err != nil {
		return SourceView{}, fmt.Errorf("选择文件失败：%w", err)
	}
	if path == "" {
		return SourceView{}, fmt.Errorf("未选择文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return SourceView{}, fmt.Errorf("读取文件失败：%w", err)
	}
	if len(data) == 0 {
		return SourceView{}, fmt.Errorf("选择的文件为空")
	}
	if len(data) > proxyMaxSourceBytes {
		return SourceView{}, fmt.Errorf("选择的文件过大（上限 32 MB）")
	}
	nodes, err := parseProxyNodes(data)
	if err != nil {
		return SourceView{}, fmt.Errorf("解析配置文件失败（已保留原有节点）：%w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.replaceNodesLocked(ctx, id, nodes); err != nil {
		return SourceView{}, err
	}
	// Refresh the stored copy so it matches the nodes now in
	// use. The database is the runtime truth; a copy that
	// cannot be rewritten is logged, not fatal.
	if err := os.MkdirAll(s.sourcesDir(), 0o750); err == nil {
		tmp := filepath.Join(s.sourcesDir(), src.FileName+".tmp")
		if err := os.WriteFile(tmp, data, 0o640); err == nil {
			if err := os.Rename(tmp, filepath.Join(s.sourcesDir(), src.FileName)); err != nil {
				_ = os.Remove(tmp)
				s.log.Warn("proxy: refresh source file copy", "source", id, "error", err)
			}
		}
	}
	if err := s.reloadLocked(ctx); err != nil {
		return SourceView{}, err
	}
	return SourceView{ID: src.ID, Name: src.Name, Kind: src.Kind, NodeCount: len(nodes)}, nil
}

func (s *ProxyService) refreshSource(id string) (SourceView, error) {
	ctx := context.Background()
	src, err := s.store.GetProxySource(ctx, id)
	if err != nil {
		return SourceView{}, fmt.Errorf("配置不存在")
	}
	if src.Kind != model.ProxySourceKindSubscription {
		return SourceView{}, fmt.Errorf("本地配置文件请使用「更新」重新选择文件")
	}
	if s.vault == nil || src.SecretRef == "" {
		return SourceView{}, fmt.Errorf("订阅地址不可用（凭据 Vault 中缺失）")
	}
	plain, err := s.vault.Get(src.SecretRef)
	if err != nil {
		return SourceView{}, fmt.Errorf("读取订阅地址失败：%w", err)
	}
	dctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	data, err := s.fetchSubscription(dctx, string(plain))
	cancel()
	if err != nil {
		return SourceView{}, fmt.Errorf("下载订阅失败（已保留原有节点）：%w", err)
	}
	nodes, err := parseProxyNodes(data)
	if err != nil {
		return SourceView{}, fmt.Errorf("解析订阅失败（已保留原有节点）：%w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.replaceNodesLocked(ctx, id, nodes); err != nil {
		return SourceView{}, err
	}
	if err := s.reloadLocked(ctx); err != nil {
		return SourceView{}, err
	}
	return SourceView{ID: src.ID, Name: src.Name, Kind: src.Kind, NodeCount: len(nodes)}, nil
}

// replaceNodesLocked reconciles one source's node set with the parsed
// nodes in a single transaction. Caller holds s.mu and has fully parsed
// the new content already, so a failed update never reaches this point
// and the old nodes stay untouched. Nodes are matched by name: a node
// that still exists keeps its ID (and therefore its instance bindings),
// only its definition is refreshed; nodes that really disappeared are
// deleted, and their bindings cascade away with them.
func (s *ProxyService) replaceNodesLocked(ctx context.Context, sourceID string, nodes []parsedNode) error {
	return s.store.WithTx(ctx, func(tx *store.Store) error {
		existing, err := tx.ListProxyNodesOfSource(ctx, sourceID)
		if err != nil {
			return err
		}
		byName := make(map[string]model.ProxyNode, len(existing))
		for _, n := range existing {
			byName[n.Name] = n
		}
		kept := make(map[string]bool, len(nodes))
		for _, n := range nodes {
			cfgJSON, err := json.Marshal(n.cfg)
			if err != nil {
				return err
			}
			config, err := s.protectNodeConfig(cfgJSON)
			if err != nil {
				return err
			}
			if old, ok := byName[n.name]; ok {
				kept[old.ID] = true
				// Compare the plaintext definitions: the stored form
				// is encrypted and differs on every seal.
				oldPlain, derr := s.unprotectNodeConfig(old.ConfigJSON)
				if derr != nil || string(oldPlain) != string(cfgJSON) {
					if err := tx.UpdateProxyNodeConfig(ctx, old.ID, config); err != nil {
						return err
					}
				}
				continue
			}
			nid, err := store.NewID()
			if err != nil {
				return err
			}
			if err := tx.CreateProxyNode(ctx, model.ProxyNode{
				ID: nid, SourceID: sourceID, Name: n.name, ConfigJSON: config,
			}); err != nil {
				return err
			}
		}
		for _, old := range existing {
			if kept[old.ID] {
				continue
			}
			if err := tx.DeleteProxyNode(ctx, old.ID); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteSource removes a source, its nodes and any bindings to
// them (database cascades). The file copy and the vault entry
// are cleaned up afterwards; their failure is logged, not
// reported as a failed deletion — the deletion has committed.
func (s *ProxyService) DeleteSource(operationID, id string) error {
	op := beginOp(s.Auditor, operationID, "代理", "proxy.source_delete", "proxy_source", id)
	err := s.deleteSource(id)
	finishOp(op, err)
	return err
}

func (s *ProxyService) deleteSource(id string) error {
	ctx := context.Background()
	src, err := s.store.GetProxySource(ctx, id)
	if err != nil {
		return fmt.Errorf("配置不存在")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.DeleteProxySource(ctx, id); err != nil {
		return err
	}
	if src.Kind == model.ProxySourceKindFile && src.FileName != "" {
		if err := os.Remove(filepath.Join(s.sourcesDir(), src.FileName)); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.log.Warn("proxy: source file copy cleanup failed after deletion", "source", id, "error", err)
		}
	}
	if src.SecretRef != "" && s.vault != nil {
		if _, err := s.vault.DeleteIfUnreferenced(src.SecretRef, func(r string) (bool, error) {
			return s.store.SecretRefInUse(ctx, r)
		}); err != nil {
			s.log.Warn("proxy: source credential cleanup failed after deletion", "source", id, "error", err)
		}
	}
	if err := s.reloadLocked(ctx); err != nil {
		s.log.Warn("proxy: core reload after source deletion failed", "source", id, "error", err)
	}
	return nil
}

// --- reads ---

// ListSources returns all imported sources with node counts.
func (s *ProxyService) ListSources() ([]SourceView, error) {
	ctx := context.Background()
	sources, err := s.store.ListProxySources(ctx)
	if err != nil {
		return nil, err
	}
	nodes, err := s.store.ListProxyNodes(ctx)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, n := range nodes {
		counts[n.SourceID]++
	}
	out := make([]SourceView, 0, len(sources))
	for _, src := range sources {
		out = append(out, SourceView{
			ID: src.ID, Name: src.Name, Kind: src.Kind,
			NodeCount: counts[src.ID], CreatedAt: src.CreatedAt,
		})
	}
	return out, nil
}
