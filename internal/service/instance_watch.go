package service

import (
	"context"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/runner"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"
)

// processExited reports whether the tracked process's exit has
// already been observed on its own exit channel — the only
// proof of exit the abort path accepts.
func processExited(p runner.Process) bool {
	select {
	case <-p.Exited():
		return true
	default:
		return false
	}
}

// confirmChildExited reports whether the exact process is
// confirmed exited, asking it to close gracefully first if it
// is still running. A close error racing a real exit still
// counts as an exit; a sent close request alone never does.
func confirmChildExited(proc runner.Process) bool {
	if processExited(proc) {
		return true
	}
	if err := proc.CloseGracefully(abortCloseTimeout); err == nil {
		return true
	}
	return processExited(proc)
}

// watchSettleHook, when set (tests only), runs inside the
// watcher's persisted cleanup after the exit has been observed
// and the restart guard established, before the database is
// settled. It lets tests hold the cleanup window open
// deterministically instead of racing it with sleeps.
var watchSettleHook func(instanceID string)

// procWatch is the lifecycle handle for one adopted browser
// process. Exactly one watcher goroutine (watchProcess) owns
// the process's exit cleanup; done is closed when that cleanup
// has run, so an operation that asked the process to close — a
// stop, a failed start's cleanup — waits for the unified
// outcome instead of cleaning up itself.
type procWatch struct {
	proc runner.Process
	done chan struct{}
	// cdpPort is the loopback Chrome DevTools Protocol port
	// assigned by the launch flow for this process (Stage 10).
	// Zero means the process has no DeBrowser-assigned CDP port
	// (allocation failed at launch, or the process was re-adopted
	// after a DeBrowser restart): such instances run normally
	// but cannot join synchronization.
	cdpPort int
	// exited is set under rtMu by the watcher the moment it
	// observes the exit, before any cleanup: a start operation
	// that sees it knows the process is gone and must not
	// persist a running state for it.
	exited bool
	// persisted reports whether a runtime record exists for
	// this process (written by a verified start or an
	// unconfirmed-exit hold, or present at re-attachment). Only
	// then does the watcher settle the database on exit; before
	// that, the start operation owns the outcome.
	persisted bool
	// stopAsked is set by a stop operation before it asks the
	// process to close: an exit the user requested through
	// DeBrowser is a normal exit for status purposes, whatever
	// its code (a browser answering SIGTERM reports -1, not 0).
	stopAsked bool
}

// watchProcess observes one adopted browser process and is the
// SINGLE owner of its exit cleanup. However the process ends —
// the user closes the window, the browser crashes, a stop
// operation's close request takes effect, or a re-attached
// browser exits after a DeBrowser restart — the watcher
// performs the final cleanup exactly once: it unregisters the
// process and, when a runtime record exists for it (the watch
// is persisted), holds a "stopping" transition for the whole
// cleanup (so the instance cannot be restarted into the path
// of this cleanup's by-ID record and status writes), deletes
// the record, clears any stale unknown hold, settles the
// persisted status from the exit code (stopped for a clean
// exit, error for an abnormal one) and records the fact. done
// is then closed, releasing any operation waiting for the
// unified outcome. A watch that is not yet persisted — a start
// still verifying its process — is only observed: the start
// operation owns the outcome until it marks the watch
// persisted.
func (s *InstanceService) watchProcess(instanceID string, w *procWatch) {
	// A panic in any watcher must not take the whole application
	// down; record it and let the instance be reconciled later.
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("instance watcher panic", "instance", instanceID, "panic", r,
				"stack", string(debug.Stack()))
		}
	}()
	<-w.proc.Exited()
	s.rtMu.Lock()
	if s.procs[instanceID] == w {
		delete(s.procs, instanceID)
	}
	w.exited = true
	persisted := w.persisted
	stopAsked := w.stopAsked
	if persisted {
		// The exit cleanup below rewrites this instance's
		// record and status by ID: until it has run, the
		// instance must not be startable again — a new start
		// would persist a fresh record and running status that
		// this cleanup would then delete and overwrite. Hold
		// the "stopping" transition for the whole cleanup; it
		// is released just before done closes. (A watch that
		// never persisted belongs to a start still in flight:
		// its "starting" transition already guards the window
		// and is not touched here.)
		s.transient[instanceID] = model.StatusStopping
	}
	s.rtMu.Unlock()
	if persisted {
		if watchSettleHook != nil {
			watchSettleHook(instanceID)
		}
		c, cancel := ctx()
		defer cancel()
		_ = s.store.DeleteInstanceRuntime(c, instanceID)
		code := w.proc.ExitCode()
		status := model.StatusStopped
		action := "浏览器进程已退出"
		recStatus := logging.StatusSuccess
		if code != 0 && !stopAsked {
			status = model.StatusError
			action = "浏览器进程异常退出"
			recStatus = logging.StatusFailed
		}
		_ = s.store.SetInstanceStatus(c, instanceID, status)
		s.clearUnverifiedMark(instanceID)
		if s.Auditor != nil {
			s.Auditor.RecordRuntime("浏览器实例", action, recStatus, map[string]string{
				"instance_id": instanceID,
				"pid":         strconv.Itoa(w.proc.PID()),
				"exit_code":   strconv.Itoa(code),
			})
		}
		s.log.Info("browser process exited", "instance", instanceID, "pid", w.proc.PID(), "exitCode", code)
		s.rtMu.Lock()
		delete(s.transient, instanceID)
		s.rtMu.Unlock()
	}
	close(w.done)
}

// detachWatch removes a watch from the tracked map while its
// watcher goroutine keeps running on the watch itself. It is
// used when a start ends in the unknown hold: the instance must
// read "unknown", not "running", yet the watcher still owns the
// process's eventual exit cleanup (and settles it, once the
// hold's runtime record makes the watch persisted).
func (s *InstanceService) detachWatch(id string, w *procWatch, persisted bool) {
	s.rtMu.Lock()
	if s.procs[id] == w {
		delete(s.procs, id)
	}
	if persisted {
		w.persisted = true
	}
	s.rtMu.Unlock()
}

// holdUnconfirmedInstance puts an instance whose browser may
// still be running — without DeBrowser being able to confirm
// its exit or keep watching it — into the "unknown" hold, and
// reports whether the hold was DURABLY established. The
// in-memory unverified mark is set first, so this session
// freezes every risky operation no matter what happens with
// persistence. Durability comes from the runtime record
// itself (with the persisted status set to running, exactly
// like a verified launch): the next startup reconciliation
// re-judges the recorded process instead of assuming it
// stopped. createdAt is the process creation time when it was
// captured (a launch whose post-launch verification failed:
// the identity is complete and reconciliation may fully
// verify and re-adopt the process) or 0 when tracking itself
// failed at launch (no creation time was ever captured, so
// the process can never be fully confirmed and is never
// adopted). A non-nil return means the record could not be
// written, so NO durable protection exists — only this
// session's memory mark — and the caller must treat the
// situation as a severe error, never as an ordinary start
// failure. (A second fallback table was tried in review and
// removed as over-engineering: real database write failures —
// disk full, I/O error, locked or damaged file — are
// database-wide and would defeat a same-database fallback
// identically, while the dual-record reconciliation it
// required produced real state bugs.)
func (s *InstanceService) holdUnconfirmedInstance(c context.Context, inst model.Instance, exe string, pid int, createdAt int64) error {
	s.rtMu.Lock()
	s.unverified[inst.ID] = true
	s.rtMu.Unlock()
	if pid <= 0 {
		return fmt.Errorf("没有可保护的进程标识")
	}
	rt := model.InstanceRuntime{
		InstanceID:       inst.ID,
		PID:              pid,
		ProcessCreatedAt: createdAt,
		Platform:         runtime.GOOS,
		ExecutablePath:   exe,
		UserDataDir:      inst.UserDataDir,
		StartedAt:        time.Now().Format(time.RFC3339),
	}
	if err := s.store.UpsertInstanceRuntime(c, rt); err != nil {
		return fmt.Errorf("运行记录写入失败：%w", err)
	}
	if err := s.store.SetInstanceStatus(c, inst.ID, model.StatusRunning); err != nil {
		// The record exists, and startup reconciliation derives
		// the hold from the record itself; the persisted status
		// is corrected there. Not a durability failure.
		s.log.Error("hold unconfirmed instance as running failed", "id", inst.ID, "err", err)
	}
	s.log.Warn("instance browser exit unconfirmed; held as unknown", "id", inst.ID, "pid", pid)
	return nil
}

// clearUnverifiedMark lifts the in-memory unknown hold (used
// when an exit that looked unconfirmable is confirmed after
// all, making the hold moot).
func (s *InstanceService) clearUnverifiedMark(id string) {
	s.rtMu.Lock()
	delete(s.unverified, id)
	s.rtMu.Unlock()
}
