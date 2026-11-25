package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/cdp"
	"time"
)

// reconcileMasterTargets re-reads the master's page target
// list once after all followers have started and offers
// every target whose URL is known. It closes the gap for a
// tab created while followers were still starting (its
// targetCreated event fired before any follower existed to
// receive the offer). Already-mapped targets are recognized
// by the workers' mapping-first ensure path, so nothing is
// created twice; a target whose URL is still unknown is
// left to the targetInfoChanged path, as before.
func (s *SyncService) reconcileMasterTargets(sess *syncSession) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	targets, err := listPageTargets(ctx, sess.masterClient)
	if err != nil {
		return
	}
	for _, ti := range targets {
		if ti.URL != "" {
			sess.noteTargetURL(ti.ID, ti.URL)
		}
		_ = sess.masterTrack.Attach(ctx, ti.ID)
		sess.offerTarget(ti.ID)
	}
}

// startFollower connects one follower and builds its initial
// mapping for ALL of the master's pre-existing page targets.
// Returns (nil, reason) on failure.
func (s *SyncService) startFollower(sess *syncSession, followerID string, masterTargets []pageTargetInfo, activeMasterTarget string) (*followerWorker, string) {
	info, ok := s.instances.SyncRuntimeInfo(followerID)
	if !ok || !info.Running || !info.Verified {
		return nil, "实例未运行或运行状态无法确认"
	}
	if info.CDPPort == 0 {
		return nil, "实例没有可用的调试端口，请重新启动该实例"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, err := dialInstance(ctx, info)
	if err != nil {
		return nil, "连接调试通道失败"
	}
	w := newFollowerWorker(followerID, client, func(id, reason string) {
		sess.noteFollowerFailed(id, reason)
	})
	if _, err := client.Call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}); err != nil {
		client.Close()
		return nil, "发现标签失败"
	}
	// Initial mapping for every pre-existing master tab:
	// the follower's own existing tabs are reused first and
	// new tabs are created only where no counterpart can be
	// reused. A tab whose correspondence cannot be
	// established reliably fails THIS follower's start with
	// a clear reason — mappings are never guessed.
	if err := w.initTargets(ctx, masterTargets, activeMasterTarget); err != nil {
		client.Close()
		if errors.Is(err, errInitialMapping) {
			return nil, errInitialMapping.Error() + "，请关闭多余标签页后重试"
		}
		return nil, "建立已有标签页对应关系失败"
	}
	// A JavaScript dialog on a follower is never answered
	// automatically (the user might cancel on the master
	// while a follower accepted — the operations would
	// diverge). It pauses the session like a master dialog;
	// when it closes, target state is re-confirmed through
	// the normal activation refresh before dispatch resumes.
	client.On("Page.javascriptDialogOpening", func(ev cdp.Event) {
		sess.setSystemPause("dialog-follower", true)
	})
	client.On("Page.javascriptDialogClosed", func(ev cdp.Event) {
		sess.setSystemPause("dialog-follower", false)
	})
	w.start(sess.ctx)
	return w, ""
}

// dialInstance discovers and dials one instance's CDP
// endpoint, both steps loopback-validated.
func dialInstance(ctx context.Context, info SyncRuntimeInfo) (*cdp.Client, error) {
	wsURL, err := cdp.Discover(ctx, info.CDPPort)
	if err != nil {
		return nil, err
	}
	return cdp.Dial(ctx, wsURL)
}

// pageTargetInfo is one browser page target as reported by
// Target.getTargets: its ID and its CURRENT URL. The URL of
// an already-open tab is final here (unlike the transient
// creation-instant URL of Target.targetCreated), which is
// what makes start-of-session mapping possible.
type pageTargetInfo struct {
	ID  string
	URL string
}

// listPageTargets returns the browser's current page targets
// in the order the browser reports them. Non-page targets
// (extensions, DevTools, background pages) are excluded. The
// reported order is preserved — initial mapping pairs
// same-URL tabs by their ordinal position in this order, so
// it must never be re-sorted or shuffled.
func listPageTargets(ctx context.Context, client *cdp.Client) ([]pageTargetInfo, error) {
	raw, err := client.Call(ctx, "", "Target.getTargets", nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
			URL      string `json:"url"`
		} `json:"targetInfos"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	infos := make([]pageTargetInfo, 0, len(out.TargetInfos))
	for _, ti := range out.TargetInfos {
		if ti.Type == "page" {
			infos = append(infos, pageTargetInfo{ID: ti.TargetID, URL: ti.URL})
		}
	}
	return infos, nil
}

// errInitialMapping marks a start-of-session tab set whose
// one-to-one correspondence cannot be established reliably.
var errInitialMapping = fmt.Errorf("无法确认主实例已有标签页与跟随实例标签页的对应关系")

// planInitialMapping deterministically pairs the master's
// pre-existing page targets with the follower's, one to one:
//
//   - A master tab pairs with the first still-unpaired
//     follower tab showing the SAME URL, both sides taken in
//     reported order — so several tabs on the same URL pair
//     by ordinal position and never share one follower tab.
//   - If exactly one master tab and one follower tab remain
//     unpaired afterwards, they pair by elimination (the
//     totals then necessarily match): this covers a tab
//     whose URL is not yet known on one side, e.g. a fresh
//     new-tab page.
//   - A master tab that remains unpaired and has a known URL
//     is returned in toCreate: the follower gets a new tab.
//   - A master tab that remains unpaired with NO known URL
//     can neither be paired nor created without guessing —
//     the whole pairing fails with errInitialMapping and the
//     follower does not start, rather than silently building
//     a wrong mapping.
//
// Follower tabs left unpaired are the follower's own
// pre-existing tabs: they stay untouched and unmapped.
func planInitialMapping(master, follower []pageTargetInfo) (pairs map[string]string, toCreate []pageTargetInfo, err error) {
	pairs = map[string]string{}
	used := map[string]bool{}
	byURL := map[string][]string{}
	for _, f := range follower {
		if f.URL != "" {
			byURL[f.URL] = append(byURL[f.URL], f.ID)
		}
	}
	var restM []pageTargetInfo
	for _, m := range master {
		if m.URL != "" {
			if q := byURL[m.URL]; len(q) > 0 {
				pairs[m.ID] = q[0]
				used[q[0]] = true
				byURL[m.URL] = q[1:]
				continue
			}
		}
		restM = append(restM, m)
	}
	var restF []pageTargetInfo
	for _, f := range follower {
		if !used[f.ID] {
			restF = append(restF, f)
		}
	}
	if len(restM) == 1 && len(restF) == 1 {
		m, f := restM[0], restF[0]
		if m.URL == "" || f.URL == "" || m.URL == f.URL {
			pairs[m.ID] = f.ID
			restM, restF = nil, nil
		}
	}
	for _, m := range restM {
		if m.URL == "" {
			return nil, nil, errInitialMapping
		}
		toCreate = append(toCreate, m)
	}
	return pairs, toCreate, nil
}
