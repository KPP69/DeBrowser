package service

import (
	"context"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/winmgr"
	"sort"
	"strings"
	"sync"
	"time"
)

// SyncService is the Stage 10 multi-instance synchronization
// service: one master instance's page interactions and browser
// operations are mirrored to follower instances, each fully
// isolated. Page operations travel over per-instance loopback
// CDP connections; window geometry travels over Win32 window
// APIs that never activate a window; the browser's native UI
// is only OBSERVED (low-level hooks + UIA classification) —
// effects that CDP confirms (a committed navigation) are what
// get synchronized, never simulated input.
//
// Privacy: page event payloads (including text increments)
// exist only in session memory. Nothing about page content,
// URLs, input text or CDP traffic is logged or persisted; the
// unified log records session lifecycle facts only.
type SyncService struct {
	instances *InstanceService
	Auditor   *logging.System

	mu   sync.Mutex
	sess *syncSession

	// Window arrangement state, usable with or without a
	// session. savedPlacements keeps each arranged window's
	// original placement — together with the identity it was
	// captured from — until it has been restored.
	savedMu         sync.Mutex
	savedPlacements map[uintptr]savedWindow

	// winMu serializes every window-geometry mutation:
	// arranging, restoring and the session's window mirror
	// must never move the same windows at the same time.
	winMu sync.Mutex

	// setWindowPlacement is indirect for tests.
	setWindowPlacement func(hwnd uintptr, p winmgr.Placement) error
	// verifySavedWindow re-validates a saved window's identity
	// before restore (indirect for tests).
	verifySavedWindow func(hwnd uintptr, rec savedWindow) bool
	// getWindowGeometry reads a window's placement and screen
	// rectangle together (indirect for tests).
	getWindowGeometry func(hwnd uintptr) (winmgr.Placement, winmgr.Rect, error)
	// setWindowRect applies a screen-coordinate rectangle
	// (indirect for tests).
	setWindowRect func(hwnd uintptr, r winmgr.Rect) error
	// windowOwnerPID reads a window's owner PID (indirect
	// for tests).
	windowOwnerPID func(hwnd uintptr) int
}

// savedWindow is one window's pre-arrange placement PLUS the
// identity it was captured from. A bare HWND is never trusted
// at restore time: Windows may recycle handles, so restore
// re-verifies the instance, PID, process creation time and
// the window's current owner before touching anything.
type savedWindow struct {
	InstanceID string
	PID        int
	CreatedAt  int64
	Placement  winmgr.Placement
}

// NewSyncService builds the service on top of the instance
// runtime (the only source of process identity and CDP ports).
func NewSyncService(instances *InstanceService) *SyncService {
	s := &SyncService{
		instances:          instances,
		savedPlacements:    map[uintptr]savedWindow{},
		setWindowPlacement: winmgr.SetPlacement,
	}
	s.verifySavedWindow = s.defaultVerifySavedWindow
	return s
}

// Sync phases (the session state machine):
//
//	stopped → starting → running ⇄ (paused via reasons) → stopping → stopped
//
// Pausing is not a phase: it is a set of reasons (manual, or
// system reasons such as an open dialog) over the running
// phase, so a system pause ending can never clear a manual
// pause.
const (
	syncStopped  = "stopped"
	syncStarting = "starting"
	syncRunning  = "running"
	syncStopping = "stopping"
)

// StartSync validates the selection, connects every
// participant, builds the initial target mappings and starts
// dispatching. A follower that cannot start is reported as
// failed and does not block the others; a master failure
// aborts the whole start with everything cleaned up.
func (s *SyncService) StartSync(operationID string, masterID string, followerIDs []string) (SyncStateView, error) {
	op := beginOp(s.Auditor, operationID, "sync", "start", "instance", masterID)
	view, err := s.start(masterID, followerIDs)
	finishOp(op, err)
	if err != nil {
		return SyncStateView{}, err
	}
	return view, nil
}

func (s *SyncService) start(masterID string, followerIDs []string) (SyncStateView, error) {
	if strings.TrimSpace(masterID) == "" {
		return SyncStateView{}, fmt.Errorf("请选择主实例")
	}
	seen := map[string]bool{}
	followers := make([]string, 0, len(followerIDs))
	for _, id := range followerIDs {
		if id == masterID {
			return SyncStateView{}, fmt.Errorf("主实例不能同时作为跟随实例")
		}
		if !seen[id] {
			seen[id] = true
			followers = append(followers, id)
		}
	}
	if len(followers) == 0 {
		return SyncStateView{}, fmt.Errorf("请至少选择一个跟随实例")
	}

	s.mu.Lock()
	if s.sess != nil {
		s.mu.Unlock()
		return SyncStateView{}, fmt.Errorf("同步会话已经在运行")
	}
	sess := &syncSession{
		id:            fmt.Sprintf("sync-%d", time.Now().UnixNano()),
		masterID:      masterID,
		phase:         syncStarting,
		systemPauses:  map[string]bool{},
		followers:     map[string]*followerWorker{},
		navSeen:       map[string]time.Time{},
		targetURLs:    map[string]string{},
		followerHWNDs: map[string]uintptr{},
	}
	s.sess = sess
	s.mu.Unlock()

	fail := func(err error) (SyncStateView, error) {
		s.teardown(sess, err.Error())
		return SyncStateView{}, err
	}

	masterInfo, ok := s.instances.SyncRuntimeInfo(masterID)
	if !ok || !masterInfo.Running || !masterInfo.Verified {
		return fail(fmt.Errorf("主实例未运行或运行状态无法确认"))
	}
	if masterInfo.CDPPort == 0 {
		return fail(fmt.Errorf("主实例没有可用的调试端口，请重新启动该实例后再同步"))
	}
	sess.master = masterInfo

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	masterClient, err := dialInstance(ctx, masterInfo)
	if err != nil {
		return fail(fmt.Errorf("连接主实例调试通道失败：%w", err))
	}
	sess.masterClient = masterClient
	sess.ctx, sess.cancel = context.WithCancel(context.Background())

	// Discover and attach the master's existing page targets.
	if _, err := masterClient.Call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}); err != nil {
		return fail(fmt.Errorf("发现主实例标签失败：%w", err))
	}
	sess.masterTrack = newPageTracker(masterClient, true,
		func(targetID string, ev PageEvent) { s.onMasterEvent(sess, targetID, ev) },
		func(targetID string) { sess.refreshActive() })
	masterTargets, err := listPageTargets(ctx, masterClient)
	if err != nil {
		return fail(fmt.Errorf("读取主实例标签失败：%w", err))
	}
	for _, ti := range masterTargets {
		// The getTargets URL of an already-open tab is its
		// current, final URL: record it for every target,
		// not just the active one, so start-of-session
		// mapping and later offers use real addresses.
		sess.noteTargetURL(ti.ID, ti.URL)
		if err := sess.masterTrack.Attach(ctx, ti.ID); err != nil {
			return fail(fmt.Errorf("接入主实例标签失败：%w", err))
		}
	}
	// Give visibility reports a moment to arrive, then require
	// a uniquely confirmed active target.
	deadline := time.Now().Add(2 * time.Second)
	for sess.masterTrack.VisibleTarget() == "" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	active := sess.masterTrack.VisibleTarget()
	if active == "" {
		return fail(fmt.Errorf("无法确认主实例当前显示的标签页。请先确保主实例窗口可见且只有一个活动标签页，再重试。"))
	}
	sess.activeTarget = active
	s.wireMaster(sess)

	// Followers: connect, build the mapping for ALL of the
	// master's pre-existing targets (not only the active
	// one), start their dispatchers. Failures are
	// per-follower.
	started := 0
	for _, fid := range followers {
		w, reason := s.startFollower(sess, fid, masterTargets, active)
		if w == nil {
			sess.addFollower(fid, nil) // remembered as failed below
			sess.noteFollowerFailed(fid, reason)
			continue
		}
		sess.addFollower(fid, w)
		started++
	}
	if started == 0 {
		return fail(fmt.Errorf("没有跟随实例能够开始同步"))
	}
	// A tab created on the master while followers were still
	// starting had no follower to be offered to yet: re-list
	// and offer every known target once. Offers are
	// mapping-first and single-flight, so targets that were
	// mapped during start are not duplicated.
	s.reconcileMasterTargets(sess)
	sess.refreshViewports(active)

	// Identity watchdog + window mirroring.
	go s.watchdog(sess)
	s.startMirror(sess)

	sess.mu.Lock()
	sess.phase = syncRunning
	sess.mu.Unlock()
	return s.state(), nil
}

// PauseSync records the manual pause: dispatch stops, pending
// moves/wheels are dropped and pressed inputs are released.
// Nothing is replayed later.
func (s *SyncService) PauseSync(operationID string) (SyncStateView, error) {
	op := beginOp(s.Auditor, operationID, "sync", "pause", "", "")
	sess := s.current()
	if sess == nil {
		err := fmt.Errorf("同步会话未在运行")
		finishOp(op, err)
		return SyncStateView{}, err
	}
	sess.mu.Lock()
	sess.manualPaused = true
	sess.mu.Unlock()
	sess.forEachFollower(func(w *followerWorker) {
		w.requestPurgeAndRelease()
	})
	finishOp(op, nil)
	return s.state(), nil
}

// ResumeSync clears the manual pause after re-verifying every
// participant's identity and the target mappings.
func (s *SyncService) ResumeSync(operationID string) (SyncStateView, error) {
	op := beginOp(s.Auditor, operationID, "sync", "resume", "", "")
	sess := s.current()
	if sess == nil {
		err := fmt.Errorf("同步会话未在运行")
		finishOp(op, err)
		return SyncStateView{}, err
	}
	if !s.instances.VerifySyncIdentity(sess.master) {
		err := fmt.Errorf("主实例已退出或身份无法确认，同步会话结束")
		s.teardown(sess, err.Error())
		finishOp(op, err)
		return SyncStateView{}, err
	}
	sess.forEachFollower(func(w *followerWorker) {
		if w == nil {
			return
		}
		if info, ok := s.instances.SyncRuntimeInfo(w.id); !ok || !s.instances.VerifySyncIdentity(info) {
			w.markFailed("实例已退出或身份无法确认")
		}
	})
	sess.mu.Lock()
	sess.manualPaused = false
	sess.mu.Unlock()
	sess.forEachFollower(func(w *followerWorker) {
		if w != nil {
			w.clearPending()
		}
	})
	sess.refreshActive()
	// Resume succeeds only when the session is REALLY back
	// in the running, unpaused phase. A surviving system
	// pause (unconfirmed active target, an open dialog) is
	// reported with its reason — never cleared by force and
	// never reported as a successful resume.
	if reason := sess.pauseReasonText(); reason != "" {
		err := fmt.Errorf("同步仍处于暂停状态：%s", reason)
		finishOp(op, err)
		return s.state(), err
	}
	finishOp(op, nil)
	return s.state(), nil
}

// StopSync ends the session and releases every resource.
func (s *SyncService) StopSync(operationID string) (SyncStateView, error) {
	op := beginOp(s.Auditor, operationID, "sync", "stop", "", "")
	sess := s.current()
	if sess == nil {
		finishOp(op, nil)
		return s.state(), nil
	}
	s.teardown(sess, "")
	finishOp(op, nil)
	return s.state(), nil
}

func (s *SyncService) current() *syncSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sess
}

// teardown releases a session completely: hook, connections,
// workers, mappings and mirroring. Browsers keep running.
func (s *SyncService) teardown(sess *syncSession, reason string) {
	s.mu.Lock()
	if s.sess == sess {
		s.sess = nil
	}
	s.mu.Unlock()

	sess.mu.Lock()
	if sess.tornDown {
		sess.mu.Unlock()
		return
	}
	sess.tornDown = true
	sess.phase = syncStopping
	sess.failReason = reason
	sess.mu.Unlock()

	// Wait out a window-mirror tick that already passed its
	// live check: mirrorOnce holds winMu for its whole apply
	// phase, so acquiring it here guarantees no mirror is
	// still moving follower windows while the session is
	// torn down — StopSync must not return with one last
	// mirror application still in flight. A tick arriving
	// after the tornDown mark fails its live check and
	// returns immediately, so this never waits on future
	// ticks. Lock order: no caller of teardown holds winMu,
	// and mirrorOnce never calls teardown.
	s.winMu.Lock()
	s.winMu.Unlock()

	// Each worker's close first releases its pressed inputs
	// through its own serial dispatcher, then stops it.
	sess.forEachFollower(func(w *followerWorker) {
		w.close()
	})
	if sess.masterClient != nil {
		sess.masterClient.Close()
	}
	if sess.cancel != nil {
		sess.cancel()
	}
	sess.mu.Lock()
	sess.phase = syncStopped
	sess.mu.Unlock()
}

// teardownMasterGone ends a session whose master went away
// (its CDP connection dropped, or the watchdog found its
// identity gone). When the instance runtime CONFIRMS the
// master process is no longer running, every master tab is
// gone with it — including the last one, whose destruction
// event may never have arrived because the connection died
// with the process. A closure is therefore queued for every
// mapped master target before teardown: closures that the
// real destruction event already queued are recognized as
// duplicates by the workers (mapping-first, dropped after
// closing), and each worker's close drains its queue so the
// closures are executed before its connection closes — the
// followers end with no mapped tab left behind. When the
// master process is NOT confirmed gone (e.g. only the debug
// connection dropped), no tab is touched: the session simply
// ends, exactly like a manual stop.
func (s *SyncService) teardownMasterGone(sess *syncSession, reason string) {
	gone := true
	if s.instances != nil {
		if info, ok := s.instances.SyncRuntimeInfo(sess.masterID); ok && info.Running {
			gone = false
		}
	}
	if gone {
		sess.forEachFollower(func(w *followerWorker) {
			for _, mt := range w.mappedMasterTargets() {
				w.enqueue(PageEvent{Kind: "targetclosed", Source: mt})
			}
		})
	}
	s.teardown(sess, reason)
}

// GetSyncState returns the current state for the UI.
func (s *SyncService) GetSyncState(operationID string) (SyncStateView, error) {
	return s.state(), nil
}

func (s *SyncService) state() SyncStateView {
	sess := s.current()
	names := map[string]string{}
	if list, err := s.instances.ListInstances(); err == nil {
		for _, inst := range list {
			names[inst.ID] = inst.Name
		}
	}
	if sess == nil {
		return SyncStateView{Phase: "已停止", Participants: []SyncParticipantView{}}
	}
	// Every participant's status derives from the ONE real
	// session phase: the master never reports 同步中 while
	// the session is starting, paused or stopping. A
	// follower's own failure stays its independent status
	// and is never overwritten by the session phase.
	label := sess.phaseLabel()
	view := SyncStateView{
		Phase:        label,
		MasterID:     sess.masterID,
		MasterName:   names[sess.masterID],
		MirrorActive: sess.masterHWND != 0,
		Participants: []SyncParticipantView{},
	}
	view.Participants = append(view.Participants, SyncParticipantView{
		InstanceID: sess.masterID, Name: names[sess.masterID], Role: "master", Status: label,
	})
	snapshot := sess.followersSnapshot()
	ids := make([]string, 0, len(snapshot))
	for id := range snapshot {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := SyncParticipantView{InstanceID: id, Name: names[id], Role: "follower", Status: label}
		if w := snapshot[id]; w == nil || w.isFailed() {
			p.Status = "失败"
			p.Reason = sess.failedReason(id)
		}
		view.Participants = append(view.Participants, p)
	}
	return view
}
