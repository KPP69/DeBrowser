package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/KPP69/DeBrowser/internal/capture"
	"github.com/KPP69/DeBrowser/internal/cdp"
)

// syncWorldName is the isolated world the observer script runs in.
// The report binding is registered globally (for every execution
// context), and bindingCalled reports are accepted only when they
// come from a context recorded in isoCtx — i.e. an isolated world
// created for this sync world. A page's own scripts (the main
// world) can therefore never forge events, and navigation, which
// creates a fresh isolated-world context, no longer breaks sync:
// the new context is recorded as soon as it appears.
const syncWorldName = "debrowser-sync"

// pageTracker attaches to the page targets of ONE browser
// connection (the master's or a follower's), installs the
// observer script on the master side, and tracks which targets
// are ready to receive input. Attach is single-flight per
// target: concurrent triggers share one attach sequence and
// its outcome, and a failed attach leaves nothing behind.
type pageTracker struct {
	client  *cdp.Client
	master  bool
	onEvent func(targetID string, ev PageEvent)
	onReady func(targetID string)

	mu         sync.Mutex
	sessions   map[string]string // targetID -> sessionID
	mainFrames map[string]string // targetID -> main frameID
	// isoCtx records every isolated-world execution context
	// seen for a session (keyed by sessionID, not targetID):
	// the explicitly created world, the worlds created for
	// new documents, and sub-frame worlds alike. Navigation
	// creates a fresh context, which is simply added; stale
	// IDs stay in the set harmlessly until the session is
	// forgotten. A context ID is never trusted merely for
	// being present here — it must also be a context the
	// browser reported for this session's sync world.
	isoCtx    map[string]map[int]bool
	attaching map[string]*attachCall
	ready     map[string]bool
	visible   map[string]bool
	urls      map[string]string

	// log is the run-category logger (logging.System.Logger),
	// set by the owning service when one exists; nil in tests
	// and when no auditor is configured, in which case
	// diagnostic logging is skipped.
	log *slog.Logger
}

type attachCall struct {
	done chan struct{}
	err  error
}

func newPageTracker(client *cdp.Client, master bool, onEvent func(string, PageEvent), onReady func(string)) *pageTracker {
	t := &pageTracker{
		client:     client,
		master:     master,
		onEvent:    onEvent,
		onReady:    onReady,
		sessions:   map[string]string{},
		mainFrames: map[string]string{},
		isoCtx:     map[string]map[int]bool{},
		attaching:  map[string]*attachCall{},
		ready:      map[string]bool{},
		visible:    map[string]bool{},
		urls:       map[string]string{},
	}
	if client != nil {
		client.On("Runtime.bindingCalled", t.onBindingCalled)
		client.On("Runtime.executionContextCreated", t.onContextCreated)
		client.On("Page.frameNavigated", t.onFrameNavigated)
	}
	return t
}

// Session returns the attached session for a target.
func (t *pageTracker) Session(targetID string) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s, ok := t.sessions[targetID]
	return s, ok
}

// IsReady reports whether the target's page is attached and
// its main frame is known.
func (t *pageTracker) IsReady(targetID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ready[targetID]
}

// WaitReady blocks until the target is ready or ctx ends.
func (t *pageTracker) WaitReady(ctx context.Context, targetID string) error {
	for {
		if t.IsReady(targetID) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// VisibleTarget returns the unique target currently reporting
// itself visible, or "" when there is none or more than one —
// callers must treat "" as "cannot confirm", never guess.
func (t *pageTracker) VisibleTarget() string {
	id, count := t.visibleState()
	if count != 1 {
		return ""
	}
	return id
}

// visibleState reports the currently visible targets as a
// count plus the single visible target when the count is
// exactly one. "None visible" (a covered or minimized window,
// or reports not yet arrived) and "several visible" (which
// must never be guessed between) stay distinguishable for
// callers and tests, even though both mean "cannot confirm"
// for activation purposes.
func (t *pageTracker) visibleState() (string, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	found := ""
	count := 0
	for id, v := range t.visible {
		if !v {
			continue
		}
		count++
		if found == "" {
			found = id
		}
	}
	if count != 1 {
		return "", count
	}
	return found, count
}

// mainFrameOf returns the tracked main frame ID of a target.
func (t *pageTracker) mainFrameOf(targetID string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.mainFrames[targetID]
}

// URL returns the last known main-frame URL of a target
// (session memory only; never logged).
func (t *pageTracker) URL(targetID string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.urls[targetID]
}

// Forget drops all bookkeeping for a destroyed target,
// including its isolated-world context set, so long-running
// sessions do not accumulate stale entries.
func (t *pageTracker) Forget(targetID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if sid, ok := t.sessions[targetID]; ok {
		delete(t.isoCtx, sid)
	}
	delete(t.sessions, targetID)
	delete(t.mainFrames, targetID)
	delete(t.ready, targetID)
	delete(t.visible, targetID)
	delete(t.urls, targetID)
}

// Attach attaches to a page target exactly once per target at
// a time. Followers only attach (no script, no binding); the
// master additionally enables Page/Runtime, registers the
// report binding and installs the observer script.
func (t *pageTracker) Attach(ctx context.Context, targetID string) error {
	t.mu.Lock()
	if _, ok := t.sessions[targetID]; ok {
		t.mu.Unlock()
		return nil
	}
	if call, ok := t.attaching[targetID]; ok {
		t.mu.Unlock()
		select {
		case <-call.done:
			return call.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	call := &attachCall{done: make(chan struct{})}
	t.attaching[targetID] = call
	t.mu.Unlock()

	err := t.attach(ctx, targetID)

	t.mu.Lock()
	delete(t.attaching, targetID)
	call.err = err
	close(call.done)
	if err != nil {
		// The attach defer already dropped this target's
		// isoCtx entry (if any) together with the session.
		delete(t.sessions, targetID)
		delete(t.mainFrames, targetID)
		delete(t.ready, targetID)
	}
	t.mu.Unlock()
	return err
}

func (t *pageTracker) attach(ctx context.Context, targetID string) (err error) {
	raw, err := t.client.Call(ctx, "", "Target.attachToTarget", map[string]any{
		"targetId": targetID, "flatten": true,
	})
	if err != nil {
		return err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &attached); err != nil || attached.SessionID == "" {
		return fmt.Errorf("附加到页面失败")
	}
	sid := attached.SessionID
	t.mu.Lock()
	t.sessions[targetID] = sid
	t.mu.Unlock()
	// Any failure from here on must give the session back:
	// detach it and drop the bookkeeping, so a half-attached
	// target never lingers.
	defer func() {
		if err != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, _ = t.client.Call(dctx, "", "Target.detachFromTarget", map[string]any{"sessionId": sid})
			dcancel()
			t.mu.Lock()
			delete(t.sessions, targetID)
			delete(t.mainFrames, targetID)
			delete(t.isoCtx, sid)
			delete(t.ready, targetID)
			t.mu.Unlock()
		}
	}()

	if _, err := t.client.Call(ctx, sid, "Page.enable", nil); err != nil {
		return err
	}
	if _, err := t.client.Call(ctx, sid, "Runtime.enable", nil); err != nil {
		return err
	}
	if t.master {
		// Global registration: the binding exists in every
		// execution context, and onBindingCalled admits only
		// reports from contexts recorded in isoCtx. Scoping
		// the registration to the isolated world by name
		// would leave contexts created after a navigation
		// unbound — the exact failure this set-based filter
		// replaces.
		if _, err := t.client.Call(ctx, sid, "Runtime.addBinding", map[string]any{
			"name": capture.BindingName,
		}); err != nil {
			return err
		}
		if _, err := t.client.Call(ctx, sid, "Page.addScriptToEvaluateOnNewDocument", map[string]any{
			"source": capture.Script, "worldName": syncWorldName,
		}); err != nil {
			return err
		}
	}
	// Learn the main frame so readiness can be established.
	raw, err = t.client.Call(ctx, sid, "Page.getFrameTree", nil)
	if err != nil {
		return err
	}
	var tree struct {
		FrameTree struct {
			Frame struct {
				ID string `json:"id"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := json.Unmarshal(raw, &tree); err != nil || tree.FrameTree.Frame.ID == "" {
		return fmt.Errorf("读取页面框架失败")
	}
	t.mu.Lock()
	t.mainFrames[targetID] = tree.FrameTree.Frame.ID
	t.ready[targetID] = true
	t.mu.Unlock()
	if t.master {
		// The observer MUST be live in the already-loaded
		// document: without an event source the session
		// would report success while syncing nothing, so a
		// failure here fails the attach (and with it, for
		// the master, the whole StartSync).
		if err := t.installInExistingWorld(ctx, targetID, sid); err != nil {
			return fmt.Errorf("在主实例页面安装观察脚本失败：%w", err)
		}
	}
	if t.onReady != nil {
		go t.onReady(targetID)
	}
	return nil
}

// installInExistingWorld evaluates the observer script in an
// isolated world of the page that already exists (the script
// registered for new documents does not run in documents that
// predate the attach).
func (t *pageTracker) installInExistingWorld(ctx context.Context, targetID, sid string) error {
	t.mu.Lock()
	frameID := t.mainFrames[targetID]
	t.mu.Unlock()
	if frameID == "" {
		return fmt.Errorf("页面主框架未知")
	}
	raw, err := t.client.Call(ctx, sid, "Page.createIsolatedWorld", map[string]any{
		"frameId": frameID, "worldName": "debrowser-sync", "grantUniveralAccess": false,
	})
	if err != nil {
		return err
	}
	var world struct {
		ExecutionContextID int `json:"executionContextId"`
	}
	if err := json.Unmarshal(raw, &world); err != nil || world.ExecutionContextID == 0 {
		return fmt.Errorf("创建页面隔离执行环境失败")
	}
	t.mu.Lock()
	if t.isoCtx[sid] == nil {
		t.isoCtx[sid] = map[int]bool{}
	}
	t.isoCtx[sid][world.ExecutionContextID] = true
	t.mu.Unlock()
	// No addBinding here: the binding is registered globally
	// at attach time, so it already exists in this world.
	if _, err := t.client.Call(ctx, sid, "Runtime.evaluate", map[string]any{
		"expression": capture.Script, "contextId": world.ExecutionContextID,
	}); err != nil {
		return err
	}
	return nil
}

// onContextCreated is pure bookkeeping: whenever the browser
// reports a new execution context for the sync isolated world
// — the main frame's world after a navigation, or a sub-frame's
// world — its ID is added to the session's set in isoCtx. It
// issues no CDP calls, so a later navigation can never leave
// the tracker trusting a stale context, and no event is ever
// delayed by work done here. Contexts of any other world (the
// page's main world has an empty name) are ignored.
func (t *pageTracker) onContextCreated(ev cdp.Event) {
	if !t.master {
		return
	}
	var p struct {
		Context struct {
			ID      int    `json:"id"`
			Name    string `json:"name"`
			AuxData struct {
				FrameID string `json:"frameId"`
				IsMain  bool   `json:"isMain"`
			} `json:"auxData"`
		} `json:"context"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil {
		return
	}
	if p.Context.Name != syncWorldName || p.Context.ID == 0 || ev.SessionID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	// Only record contexts for sessions this tracker owns;
	// anything else is a stray event from a session that was
	// never attached or already forgotten.
	known := false
	for _, sid := range t.sessions {
		if sid == ev.SessionID {
			known = true
			break
		}
	}
	if !known {
		return
	}
	if t.isoCtx[ev.SessionID] == nil {
		t.isoCtx[ev.SessionID] = map[int]bool{}
	}
	t.isoCtx[ev.SessionID][p.Context.ID] = true
}

func (t *pageTracker) onFrameNavigated(ev cdp.Event) {
	var p struct {
		Frame struct {
			ID       string `json:"id"`
			LoaderID string `json:"loaderId"`
			URL      string `json:"url"`
		} `json:"frame"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for targetID, frameID := range t.mainFrames {
		if frameID == p.Frame.ID {
			t.urls[targetID] = p.Frame.URL
			return
		}
	}
}

func (t *pageTracker) onBindingCalled(ev cdp.Event) {
	var p struct {
		Name               string `json:"name"`
		Payload            string `json:"payload"`
		ExecutionContextID int    `json:"executionContextId"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil || p.Name != capture.BindingName {
		return
	}
	var pageEv PageEvent
	if err := json.Unmarshal([]byte(p.Payload), &pageEv); err != nil {
		return
	}
	t.mu.Lock()
	targetID := ""
	for id, sid := range t.sessions {
		if sid == ev.SessionID {
			targetID = id
			break
		}
	}
	if targetID == "" {
		t.mu.Unlock()
		return
	}
	// Fail closed: the binding is registered globally, so a
	// report is trusted only when its execution context is a
	// recorded isolated-world context of this session. The
	// page's own main-world context — and any context never
	// reported for this session — is dropped silently for the
	// user but noted in the run log for diagnosis.
	if !t.isoCtx[ev.SessionID][p.ExecutionContextID] {
		t.mu.Unlock()
		if t.log != nil {
			t.log.Warn("同步上报来自未知执行环境，已丢弃",
				"session", shortSessionID(ev.SessionID))
		}
		return
	}
	if pageEv.Kind == "visibility" {
		t.visible[targetID] = pageEv.Visible
	}
	t.mu.Unlock()
	pageEv.Source = targetID
	if t.onEvent != nil {
		t.onEvent(targetID, pageEv)
	}
}

// shortSessionID keeps only a short opaque prefix of a CDP
// session ID for log lines; session IDs carry no URL or page
// content, and the prefix is enough to correlate entries.
func shortSessionID(sid string) string {
	if len(sid) > 8 {
		return sid[:8]
	}
	return sid
}
