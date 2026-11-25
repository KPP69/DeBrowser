package service

// Stage 9B runtime management. The rules that keep this safe:
//
//   - DeBrowser manages only the browser processes it launched
//     itself, one per instance, each tracked by a process handle
//     plus a durable identity record (instance_runtime): PID +
//     process creation time + executable path + the exact
//     instance folder in the command line.
//   - A PID alone is never trusted: the OS recycles PIDs, so
//     every re-identification verifies creation time, executable
//     path, and the command line's --user-data-dir argument —
//     parsed exactly, never substring-matched. Any signal that
//     cannot be read makes the identity unconfirmed, never
//     "close enough".
//   - A process whose identity cannot be CONFIRMED is never
//     closed, never adopted, and its instance is held in the
//     "unknown" state, which blocks every operation that could
//     endanger its data.
//   - Closing is always the graceful request (the equivalent of
//     the user closing the window). Nothing is force-killed, and
//     a close that does not complete is reported as such — the
//     instance stays "running".
//   - DeBrowser exiting never closes browsers: launched processes
//     are independent OS processes, and their runtime records let
//     the next DeBrowser start re-identify the ones still alive.

import (
	"errors"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/runner"
	"github.com/KPP69/DeBrowser/internal/store"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// abortCloseTimeout bounds the graceful close asked of a
// just-launched process whose verification failed. A variable
// so tests can shorten it.
var abortCloseTimeout = 3 * time.Second

// startSettleDelay is how long a freshly launched process must
// survive before the launch counts as successful (a field so
// tests can shorten it).
var startSettleDelay = 300 * time.Millisecond

// closeTimeout bounds one graceful close request.
var closeTimeout = 20 * time.Second

// stopConfirmTimeout bounds how long a stop operation waits for
// the watcher's unified exit cleanup after its close request:
// the request itself already waited inside CloseGracefully, so
// this only covers the watcher observing the exit and landing
// its (local) cleanup. A variable so tests can shorten it.
var stopConfirmTimeout = 2 * time.Second

// StartInstance launches the instance's browser (recorded).
func (s *InstanceService) StartInstance(operationID string, id string) error {
	op := beginOp(s.Auditor, operationID, "浏览器实例", "instance.start", "instance", id)
	err := s.startInstance(id, op)
	finishOp(op, err)
	return err
}

func (s *InstanceService) startInstance(id string, op *logging.Operation) error {
	c, cancel := ctx()
	defer cancel()
	// Serialize with bookmark file access and profile deletion: the
	// profile must not be read/written externally between the state
	// check below and the moment the browser owns it.
	unlock := s.lockInstanceFiles(id)
	defer unlock()
	inst, err := s.store.GetInstance(c, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("实例不存在")
		}
		return err
	}
	s.rtMu.Lock()
	if t, busy := s.transient[id]; busy {
		s.rtMu.Unlock()
		if t == model.StatusStarting {
			return fmt.Errorf("实例正在启动中")
		}
		return fmt.Errorf("实例正在关闭中")
	}
	if _, running := s.procs[id]; running {
		// Already running: the start requirement is satisfied —
		// never create a second process for the same instance.
		s.rtMu.Unlock()
		return nil
	}
	if s.unverified[id] {
		s.rtMu.Unlock()
		return fmt.Errorf("实例运行状态无法确认，不能启动")
	}
	s.transient[id] = model.StatusStarting
	s.rtMu.Unlock()
	fail := func(err error) error {
		s.rtMu.Lock()
		delete(s.transient, id)
		s.rtMu.Unlock()
		return err
	}

	// Kernel: the association must exist and its registration
	// must still be there. The executable path is the
	// registration's CURRENT path.
	if inst.KernelID == "" {
		return fail(fmt.Errorf("实例尚未关联浏览器内核，无法启动"))
	}
	reg, err := s.store.GetExternalBrowser(c, inst.KernelID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fail(fmt.Errorf("实例关联的浏览器内核登记不存在，无法启动"))
		}
		return fail(err)
	}
	exe := reg.ExecutablePath
	op.Step("解析浏览器内核", logging.StatusSuccess, map[string]string{"kernel_id": reg.ID})

	// Instance file: must be a managed folder directly under
	// data/profiles. A missing folder at first launch is created
	// empty; anything abnormal refuses the launch — never a
	// silent switch to another folder.
	folder := profileFolder(inst.UserDataDir)
	if folder == "" {
		return fail(fmt.Errorf("实例文件路径异常，无法启动"))
	}
	absDir := filepath.Join(s.layout.Profiles, folder)
	launchDir := absDir
	if _, lerr := os.Lstat(absDir); lerr == nil {
		resolved, verr := s.verifiedProfileTarget(inst.UserDataDir)
		if verr != nil {
			return fail(fmt.Errorf("实例文件无法安全访问：%w", verr))
		}
		if resolved != "" {
			launchDir = resolved
		}
	} else if errors.Is(lerr, os.ErrNotExist) {
		if err := os.MkdirAll(absDir, 0o755); err != nil {
			return fail(fmt.Errorf("创建实例文件目录失败：%w", err))
		}
		op.Step("创建实例文件目录", logging.StatusSuccess, map[string]string{"profile": folder})
	} else {
		return fail(fmt.Errorf("实例文件无法访问：%w", lerr))
	}
	// An untracked browser may still own the profile (it
	// restarted itself after an update). Never start a second
	// browser on the same profile.
	if profileLocked(launchDir) {
		return fail(fmt.Errorf("实例文件正被浏览器占用（可能是浏览器自行重启），请先关闭该浏览器"))
	}

	// No other tracked instance may be using this folder (the
	// unique binding already guarantees this; this is the live
	// double-check).
	s.rtMu.Lock()
	for otherID := range s.procs {
		if otherID == id {
			continue
		}
		if other, oerr := s.store.GetInstance(c, otherID); oerr == nil && other.UserDataDir == inst.UserDataDir {
			s.rtMu.Unlock()
			return fail(fmt.Errorf("实例文件正被其他实例使用，无法启动"))
		}
	}
	s.rtMu.Unlock()

	args := []string{"--user-data-dir=" + launchDir}
	// Proxy module: an instance bound to a proxy node launches
	// with the core listener dedicated to it. The hook refuses
	// the launch when the binding cannot be served (core not
	// running, listener down) — a bound instance never silently
	// falls back to a direct connection.
	if s.ProxyPortFor != nil {
		port, perr := s.ProxyPortFor(id)
		if perr != nil {
			return fail(perr)
		}
		if port > 0 {
			args = append(args, "--proxy-server=http://127.0.0.1:"+strconv.Itoa(port))
		}
	}
	// Stage 10: every launch asks the browser to open a
	// debugging port bound to loopback only, so the instance
	// CAN join multi-instance synchronization. Allocation or
	// browser support failure must never fail the launch itself:
	// the instance then simply runs without sync capability.
	cdpPort := allocateCDPPort()
	if cdpPort > 0 {
		args = append(args,
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port="+strconv.Itoa(cdpPort))
	}
	if strings.TrimSpace(inst.StartURL) != "" {
		args = append(args, strings.TrimSpace(inst.StartURL))
	}
	proc, err := s.launcher.Launch(exe, args...)
	if err != nil {
		op.Step("启动浏览器进程", logging.StatusFailed, nil)
		var untracked *runner.UntrackedChildError
		if errors.As(err, &untracked) && !untracked.ChildExited {
			// The browser may genuinely be running with this
			// instance's folder while DeBrowser holds no handle
			// on it. Hold the instance at "unknown" so no risky
			// operation — including a second start — can touch
			// it until a later reconciliation resolves the
			// record.
			if herr := s.holdUnconfirmedInstance(c, inst, exe, untracked.PID, 0); herr != nil {
				op.Step("写入运行记录", logging.StatusFailed, nil)
				return fail(fmt.Errorf("严重错误：浏览器进程可能已启动但无法建立进程跟踪，且运行记录写入失败，重启后可能无法恢复该实例的保护状态：%w", herr))
			}
			return fail(fmt.Errorf("浏览器进程可能已启动，但无法建立进程跟踪，实例已进入无法确认状态：%w", err))
		}
		return fail(fmt.Errorf("浏览器启动失败：%w", err))
	}
	op.Step("启动浏览器进程", logging.StatusSuccess, map[string]string{"pid": strconv.Itoa(proc.PID())})

	// Exit monitoring starts NOW, before any verification: from
	// this moment the watcher owns the process's exit cleanup,
	// so an exit at any point of the remaining start sequence is
	// observed exactly once and can never be overwritten by the
	// start flow persisting a running state for a dead process.
	w := &procWatch{proc: proc, done: make(chan struct{}), cdpPort: cdpPort}
	s.rtMu.Lock()
	s.procs[id] = w
	s.rtMu.Unlock()
	go s.watchProcess(id, w)

	// A process object is not proof of a running browser: the
	// process must survive the settle window, and its verified
	// identity must match what was launched.
	abort := func(err error) error {
		op.Step("确认浏览器运行", logging.StatusFailed, nil)
		// This process was started by THIS operation moments ago
		// and never became a tracked instance browser, so asking
		// IT — this exact process object, never a name or PID
		// lookup — to close is safe. But the abort counts as an
		// ordinary start failure only once the process's exit is
		// CONFIRMED: a close request having been sent (WM_CLOSE
		// posted, signal delivered) is not proof of exit, and a
		// close error racing a real exit is still an exit.
		if confirmChildExited(proc) {
			s.detachWatch(id, w, false)
			op.Step("清理未核验的浏览器进程", logging.StatusSuccess, nil)
			return fail(err)
		}
		// The process may still be running with this instance's
		// folder and its exit cannot be confirmed. Hold the
		// instance at "unknown" with a complete runtime record
		// (this launch DID capture the identity) so nothing
		// treats it as stopped, risky operations stay frozen,
		// and the next startup reconciliation re-verifies the
		// record — re-adopting the browser if it is still this
		// instance's, clearing it once the process is gone.
		op.Step("清理未核验的浏览器进程", logging.StatusFailed, nil)
		if herr := s.holdUnconfirmedInstance(c, inst, exe, proc.PID(), proc.CreatedAt()); herr != nil {
			// The hold itself could not be persisted. One last
			// resort remains: this operation still holds the
			// exact process object — try once more to close it
			// and confirm the exit. If the exit is confirmed
			// after all, the ordinary failure becomes truthful
			// again and the in-memory mark comes off.
			op.Step("写入运行记录", logging.StatusFailed, nil)
			if confirmChildExited(proc) {
				s.clearUnverifiedMark(inst.ID)
				s.detachWatch(id, w, false)
				op.Step("清理未核验的浏览器进程", logging.StatusSuccess, nil)
				return fail(err)
			}
			s.detachWatch(id, w, false)
			return fail(fmt.Errorf("严重错误：无法确认浏览器进程是否已退出，且运行记录写入失败，重启后可能无法恢复该实例的保护状态：%w", herr))
		}
		// The hold is durable: the watcher keeps owning this
		// process's exit (now with a record to settle), but the
		// instance must read "unknown", not "running", until a
		// startup reconciliation re-verifies it.
		s.detachWatch(id, w, true)
		return fail(fmt.Errorf("无法确认浏览器进程是否已退出，实例已进入无法确认状态：%w", err))
	}
	select {
	case <-proc.Exited():
		return abort(fmt.Errorf("浏览器启动后立即退出（退出代码 %d）", proc.ExitCode()))
	case <-time.After(startSettleDelay):
	}
	info, ierr := s.launcher.Inspect(proc.PID())
	if ierr != nil {
		if errors.Is(ierr, runner.ErrProcessGone) {
			return abort(fmt.Errorf("浏览器启动后立即退出"))
		}
		return abort(fmt.Errorf("无法确认浏览器进程状态：%w", ierr))
	}
	// Identity verification is fail-closed: a signal that cannot
	// be read at all is a failed verification, never a skipped
	// one. The launch counts as successful only when the
	// executable matches the chosen kernel AND the parsed
	// --user-data-dir argument names exactly this folder.
	if info.ExecutablePath == "" {
		return abort(fmt.Errorf("无法确认浏览器进程的可执行文件，已拒绝认定启动成功"))
	}
	if !strings.EqualFold(filepath.Clean(info.ExecutablePath), filepath.Clean(exe)) {
		return abort(fmt.Errorf("启动的进程与所选浏览器内核不一致"))
	}
	if !info.HasCommandLine {
		return abort(fmt.Errorf("无法读取浏览器进程的命令行，不能确认其使用的实例文件，已拒绝认定启动成功"))
	}
	if !commandLineUsesDir(info.CommandLine, launchDir) {
		return abort(fmt.Errorf("浏览器进程未使用该实例的实例文件，已拒绝认定启动成功"))
	}
	op.Step("确认浏览器运行", logging.StatusSuccess, nil)

	rt := model.InstanceRuntime{
		InstanceID:       id,
		PID:              proc.PID(),
		ProcessCreatedAt: proc.CreatedAt(),
		Platform:         runtime.GOOS,
		ExecutablePath:   exe,
		UserDataDir:      inst.UserDataDir,
		StartedAt:        time.Now().Format(time.RFC3339),
	}
	// Persist under rtMu, serialized against the watcher: if it
	// has already observed the exit, the launch is an ordinary
	// failure and nothing may be written back as running; if it
	// observes the exit during the writes, it runs after this
	// block and settles the just-written record itself.
	s.rtMu.Lock()
	if w.exited || processExited(proc) {
		s.rtMu.Unlock()
		return abort(fmt.Errorf("浏览器启动后立即退出"))
	}
	if err := s.store.UpsertInstanceRuntime(c, rt); err != nil {
		s.rtMu.Unlock()
		return abort(fmt.Errorf("保存运行状态失败：%w", err))
	}
	if err := s.store.SetInstanceStatus(c, id, model.StatusRunning); err != nil {
		_ = s.store.DeleteInstanceRuntime(c, id)
		s.rtMu.Unlock()
		return abort(fmt.Errorf("保存运行状态失败：%w", err))
	}
	w.persisted = true
	delete(s.transient, id)
	s.rtMu.Unlock()
	s.log.Info("browser instance started", "id", id, "pid", proc.PID(), "dir", inst.UserDataDir)
	return nil
}

// StopInstance gracefully closes the instance's browser
// (recorded). Only the tracked, identity-verified process of
// this instance is ever asked to close.
func (s *InstanceService) StopInstance(operationID string, id string) error {
	op := beginOp(s.Auditor, operationID, "浏览器实例", "instance.stop", "instance", id)
	err := s.stopInstance(id, op)
	finishOp(op, err)
	return err
}

func (s *InstanceService) stopInstance(id string, op *logging.Operation) error {
	c, cancel := ctx()
	defer cancel()
	inst, err := s.store.GetInstance(c, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("实例不存在")
		}
		return err
	}
	s.rtMu.Lock()
	w, tracked := s.procs[id]
	if tracked {
		if s.transient[id] == model.StatusStarting {
			s.rtMu.Unlock()
			return fmt.Errorf("实例正在启动中")
		}
		s.transient[id] = model.StatusStopping
		w.stopAsked = true
	}
	s.rtMu.Unlock()
	if !tracked {
		if s.effectiveStatus(inst) == model.StatusUnknown {
			return fmt.Errorf("实例运行状态无法确认，不能执行关闭")
		}
		return fmt.Errorf("实例未在运行")
	}
	// Ask the exact tracked process to close and let the
	// watcher own the outcome: the close request is not the
	// cleanup. The watcher stays registered; when the exit is
	// observed it alone deletes the runtime record and settles
	// the status, and its done signal releases this operation.
	// A close error is not decisive either — an exit racing it
	// still counts, through the same signal.
	//
	// Transient ownership: this operation set the "stopping"
	// transition above to mark its wait, but from here the
	// transition belongs to the watcher — for a persisted watch
	// it holds the transition through its cleanup and deletes
	// it BEFORE closing done. This operation therefore never
	// deletes the transition on the success path (a newer
	// start's own transition could already stand in its place),
	// and on the timeout path it deletes it only in the same
	// rtMu critical section that finds the watcher has not yet
	// observed the exit — the transition is then still this
	// operation's own.
	_ = w.proc.CloseGracefully(closeTimeout)
	finish := func() error {
		op.Step("关闭浏览器", logging.StatusSuccess, nil)
		s.log.Info("browser instance stopped", "id", id, "pid", w.proc.PID())
		return nil
	}
	select {
	case <-w.done:
		return finish()
	case <-time.After(stopConfirmTimeout):
	}
	// The wait timed out — but the cleanup may have landed in
	// the same instant; prefer its outcome over reporting a
	// failure for a browser that did close.
	select {
	case <-w.done:
		return finish()
	default:
	}
	// The process is still alive and still watched: this stop
	// attempt is over, so the watch must judge a later exit on
	// its own again. In one rtMu critical section: if the
	// watcher has NOT observed the exit, reset stopAsked (the
	// same lock the watcher reads it under when an exit lands)
	// and remove this operation's transition. If it HAS
	// (w.exited), its settlement is already decided from the
	// value it captured, and its cleanup transition stays
	// untouched — the watcher removes it when its cleanup
	// completes.
	s.rtMu.Lock()
	if !w.exited {
		w.stopAsked = false
		delete(s.transient, id)
	}
	s.rtMu.Unlock()
	// Report the failure truthfully, with the instance still
	// running — never a premature "stopped".
	op.Step("关闭浏览器", logging.StatusFailed, nil)
	return fmt.Errorf("关闭未完成：浏览器未能正常退出，实例仍在运行")
}
