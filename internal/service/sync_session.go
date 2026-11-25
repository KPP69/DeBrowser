package service

import (
	"context"
	"encoding/json"
	"github.com/KPP69/DeBrowser/internal/cdp"
	"github.com/KPP69/DeBrowser/internal/winmgr"
	"sort"
	"strings"
	"sync"
	"time"
)

// syncSession is one running synchronization session.
type syncSession struct {
	id       string
	masterID string
	master   SyncRuntimeInfo

	ctx    context.Context
	cancel context.CancelFunc

	mu           sync.Mutex
	phase        string
	manualPaused bool
	systemPauses map[string]bool
	tornDown     bool
	failReason   string

	masterClient *cdp.Client
	masterTrack  *pageTracker
	activeTarget string

	followersMu sync.RWMutex
	followers   map[string]*followerWorker
	order       []string

	// failedFollowers remembers start-time and runtime
	// failure reasons by follower ID (nil worker entries in
	// the followers map are start-time failures).
	failedFollowers map[string]string

	// navigation dedup (session memory only)
	navMu   sync.Mutex
	navSeen map[string]time.Time

	// Master target URLs as last reported by
	// Target.targetCreated / Target.targetInfoChanged
	// (session memory only, never logged). A target whose
	// URL is still empty is NOT yet offered to followers:
	// the creation-instant URL of a new tab is transient,
	// and materializing it produced permanent about:blank
	// tabs on followers (real-machine finding).
	targetMu   sync.Mutex
	targetURLs map[string]string

	// composition twin dedup
	compMu      sync.Mutex
	compPending bool
	compText    string

	// window mirroring
	masterHWND    uintptr
	followerHWNDs map[string]uintptr
	lastMasterPl  *winmgr.Placement
	lastMasterScr *winmgr.Rect
}

func (sess *syncSession) pausedLocked() bool {
	return sess.manualPaused || len(sess.systemPauses) > 0
}

func (sess *syncSession) live() bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.phase == syncRunning && !sess.pausedLocked() && !sess.tornDown
}

func (sess *syncSession) phaseLabel() string {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	switch sess.phase {
	case syncStarting:
		return "启动中"
	case syncRunning:
		if sess.pausedLocked() {
			return "已暂停"
		}
		return "同步中"
	case syncStopping:
		return "停止中"
	}
	return "已停止"
}

func (sess *syncSession) setSystemPause(reason string, on bool) {
	sess.mu.Lock()
	was := sess.pausedLocked()
	if on {
		sess.systemPauses[reason] = true
	} else {
		delete(sess.systemPauses, reason)
	}
	now := sess.pausedLocked()
	sess.mu.Unlock()
	if was == now {
		return
	}
	if now {
		sess.forEachFollower(func(w *followerWorker) {
			w.requestPurgeAndRelease()
		})
	} else {
		// Resuming from a system pause: re-confirm the active
		// target before events flow again.
		sess.refreshActive()
	}
}

// followersSnapshot copies the follower map under its lock;
// callers then work on the copy without holding the lock
// during CDP or window operations.
func (sess *syncSession) followersSnapshot() map[string]*followerWorker {
	sess.followersMu.RLock()
	defer sess.followersMu.RUnlock()
	out := make(map[string]*followerWorker, len(sess.followers))
	for id, w := range sess.followers {
		out[id] = w
	}
	return out
}

// addFollower is the only writer of the followers map.
func (sess *syncSession) addFollower(id string, w *followerWorker) {
	sess.followersMu.Lock()
	defer sess.followersMu.Unlock()
	if _, dup := sess.followers[id]; !dup && w != nil {
		sess.order = append(sess.order, id)
	}
	sess.followers[id] = w
}

func (sess *syncSession) forEachFollower(fn func(*followerWorker)) {
	for _, w := range sess.followersSnapshot() {
		if w != nil {
			fn(w)
		}
	}
}

func (sess *syncSession) followerByID(id string) *followerWorker {
	sess.followersMu.RLock()
	defer sess.followersMu.RUnlock()
	return sess.followers[id]
}

// dispatch fans one master page event out to every healthy
// follower, applying the composition twin dedup first.
func (sess *syncSession) dispatch(ev PageEvent) {
	if !sess.live() {
		return
	}
	// Composition dedup: Chromium delivers the IME result as a
	// compositionend and then AGAIN as an input increment with
	// the same text. The twin is dropped exactly once.
	sess.compMu.Lock()
	if ev.Kind == "input" && sess.compPending && ev.Text == sess.compText {
		sess.compPending = false
		sess.compMu.Unlock()
		return
	}
	if ev.Kind == "compositionend" {
		sess.compPending = true
		sess.compText = ev.Text
	} else if ev.Kind != "input" {
		sess.compPending = false
	}
	sess.compMu.Unlock()

	sess.forEachFollower(func(w *followerWorker) {
		w.enqueue(ev)
	})
}

// refreshActive re-derives the active master target from page
// visibility and, when it changed, points every follower at
// the corresponding target.
// noteTargetURL records a master target's latest known URL
// from its lifecycle events.
func (sess *syncSession) noteTargetURL(tid, url string) {
	sess.targetMu.Lock()
	defer sess.targetMu.Unlock()
	if sess.targetURLs == nil {
		sess.targetURLs = map[string]string{}
	}
	sess.targetURLs[tid] = url
}

// forgetTargetURL drops a destroyed target's record.
func (sess *syncSession) forgetTargetURL(tid string) {
	sess.targetMu.Lock()
	defer sess.targetMu.Unlock()
	delete(sess.targetURLs, tid)
}

// targetURL returns the last known URL ("" = not known yet).
func (sess *syncSession) targetURL(tid string) string {
	sess.targetMu.Lock()
	defer sess.targetMu.Unlock()
	return sess.targetURLs[tid]
}

// offerTarget asks every follower to create its counterpart
// of a master target — but ONLY once the target's URL is
// known. While the URL is still empty (the transient state
// of a just-created tab), nothing is created; the later
// Target.targetInfoChanged update offers it then. Followers
// that already have the mapping ignore the offer (their
// ensure path is single-flight and mapping-first), so
// repeated offers never duplicate a tab.
func (sess *syncSession) offerTarget(tid string) {
	url := sess.targetURL(tid)
	if url == "" {
		return
	}
	sess.forEachFollower(func(w *followerWorker) {
		w.enqueue(PageEvent{Kind: "targetcreated", Source: tid, Text: url})
	})
}

func (sess *syncSession) refreshActive() {
	if sess.masterTrack == nil {
		return
	}
	active, visibleCount := sess.masterTrack.visibleState()
	if visibleCount != 1 {
		// No unique visible target: pause. The previously
		// confirmed active target is KEPT — a transient
		// invisibility (the master window covered or
		// minimized) must not discard it; a destroyed target
		// is cleared by the destruction handler before this
		// runs, so a stale target is never revived here.
		sess.setSystemPause("target", true)
		return
	}
	sess.setSystemPause("target", false)
	sess.mu.Lock()
	changed := active != sess.activeTarget
	if changed {
		sess.activeTarget = active
	}
	sess.mu.Unlock()
	if !changed {
		return
	}
	sess.offerTarget(active)
	sess.forEachFollower(func(w *followerWorker) {
		w.enqueue(PageEvent{Kind: "targetactivated", Source: active})
	})
	go sess.refreshViewports(active)
}

func (sess *syncSession) refreshViewports(masterTarget string) {
	mw, mh, ok := viewportOf(sess.masterClient, sess.masterTrack, masterTarget)
	if !ok {
		return
	}
	sess.forEachFollower(func(w *followerWorker) {
		if ft, ok := w.mappedTarget(masterTarget); ok {
			if fw, fh, ok := viewportOf(w.client, w.track, ft); ok {
				w.setViewports(mw, mh, fw, fh)
			}
		}
	})
}

// viewportOf reads one page's CSS layout viewport size.
func viewportOf(client *cdp.Client, track *pageTracker, targetID string) (float64, float64, bool) {
	sid, ok := track.Session(targetID)
	if !ok {
		return 0, 0, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	raw, err := client.Call(ctx, sid, "Page.getLayoutMetrics", nil)
	if err != nil {
		return 0, 0, false
	}
	var m struct {
		LayoutViewport struct {
			ClientWidth  float64 `json:"clientWidth"`
			ClientHeight float64 `json:"clientHeight"`
		} `json:"layoutViewport"`
	}
	if err := json.Unmarshal(raw, &m); err != nil || m.LayoutViewport.ClientWidth <= 0 {
		return 0, 0, false
	}
	return m.LayoutViewport.ClientWidth, m.LayoutViewport.ClientHeight, true
}

func (sess *syncSession) noteFollowerFailed(id, reason string) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.failedFollowers == nil {
		sess.failedFollowers = map[string]string{}
	}
	sess.failedFollowers[id] = reason
}

// pauseReasonText describes why the session is not in the
// plain running state, or "" when it is running unpaused.
// System pause keys are internal; the user-facing text is
// fixed per known key.
func (sess *syncSession) pauseReasonText() string {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.phase != syncRunning {
		return "同步会话尚未进入运行状态"
	}
	var parts []string
	if sess.manualPaused {
		parts = append(parts, "已手动暂停")
	}
	keys := make([]string, 0, len(sess.systemPauses))
	for k := range sess.systemPauses {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch k {
		case "target":
			parts = append(parts, "无法确认主实例当前显示的标签页")
		case "dialog-master":
			parts = append(parts, "主实例有未处理的对话框")
		case "dialog-follower":
			parts = append(parts, "跟随实例有未处理的对话框")
		default:
			parts = append(parts, "系统原因")
		}
	}
	return strings.Join(parts, "；")
}

func (sess *syncSession) failedReason(id string) string {
	sess.mu.Lock()
	if sess.failedFollowers != nil {
		if r := sess.failedFollowers[id]; r != "" {
			sess.mu.Unlock()
			return r
		}
	}
	sess.mu.Unlock()
	if w := sess.followerByID(id); w != nil {
		return w.failureReason()
	}
	return "同步失败"
}
