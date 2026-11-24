package service

import (
	"context"
	"errors"
	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/runner"
	"path/filepath"
	"runtime"
	"strings"
)

// reconcileEvent is one startup-reconciliation outcome, buffered
// until the unified record is wired (see ReportReconciliation).
type reconcileEvent struct {
	instanceID string
	action     string
	status     string
	detail     string
}

func (s *InstanceService) noteReconcile(instanceID, action, status, detail string) {
	s.reconcileEvents = append(s.reconcileEvents, reconcileEvent{
		instanceID: instanceID, action: action, status: status, detail: detail,
	})
}

// ReportReconciliation flushes the startup runtime reconciliation
// outcomes into the unified record. main calls it right after
// wiring the Auditor (the reconciliation itself runs in the
// constructor, before an Auditor can exist).
func (s *InstanceService) ReportReconciliation() {
	if s.Auditor == nil {
		return
	}
	for _, ev := range s.reconcileEvents {
		meta := map[string]string{"instance_id": ev.instanceID}
		if ev.detail != "" {
			meta["detail"] = ev.detail
		}
		s.Auditor.RecordRuntime("浏览器实例", ev.action, ev.status, meta)
	}
	s.reconcileEvents = nil
}

// reconcileRuntimeAtStartup brings persisted state in line with
// live process facts, once, at service construction:
//
//   - instances persisted "running" with NO runtime record are
//     pre-tracking leftovers: stopped (store.ReconcileInstance
//     Statuses);
//   - each runtime record is verified against the live process
//     (see verifyRecordedProcess): verified processes are
//     re-attached and watched; disproved records are removed and
//     their instances stopped; processes that exist but cannot be
//     confirmed are left recorded and their instances set to
//     "unknown" — a safe hold, neither closed nor acted on.
func (s *InstanceService) reconcileRuntimeAtStartup(c context.Context) error {
	if n, err := s.store.ReconcileInstanceStatuses(c); err != nil {
		return err
	} else if n > 0 {
		s.log.Info("reconciled stale running instances to stopped", "count", n)
	}
	records, err := s.store.ListInstanceRuntimes(c)
	if err != nil {
		return err
	}
	for _, rt := range records {
		s.reconcileOne(c, rt)
	}
	return nil
}

// verifyOutcome classifies a recorded process against the live OS.
type verifyOutcome int

const (
	verifyGone      verifyOutcome = iota // provably not running anymore
	verifyNotOurs                        // a live process exists but is provably NOT this instance's browser
	verifyConfirmed                      // identity fully verified
	verifyUnknown                        // exists (or may exist) but cannot be confirmed either way
)

// verifyRecordedProcess compares one runtime record with the live
// process at its PID. Confirmation requires EVERY identity signal
// to check out: creation time, executable path, and the parsed
// --user-data-dir argument naming exactly this instance's folder.
// A signal that DISPROVES the identity (a different process now
// owns the PID) clears the record; a signal that merely cannot
// be READ leaves the instance at "unknown" — never adopted,
// never acted on.
func (s *InstanceService) verifyRecordedProcess(rt model.InstanceRuntime) (verifyOutcome, runner.Process) {
	if rt.Platform != "" && rt.Platform != runtime.GOOS {
		return verifyUnknown, nil // recorded on another OS: unverifiable here
	}
	info, err := s.launcher.Inspect(rt.PID)
	if err != nil {
		if errors.Is(err, runner.ErrProcessGone) {
			return verifyGone, nil
		}
		// Access denied (or any other inspection failure): the
		// process may well be alive — nothing may be concluded.
		return verifyUnknown, nil
	}
	// unprovable collects the signals that could not be checked;
	// any one of them caps the outcome at "unknown".
	unprovable := false
	if rt.ProcessCreatedAt <= 0 {
		// The record was written when tracking failed at launch:
		// no creation time was ever captured, so PID reuse can
		// never be ruled out and the process can never be fully
		// confirmed — at best it stays unknown while it lives.
		unprovable = true
	} else if info.CreatedAt != rt.ProcessCreatedAt {
		return verifyNotOurs, nil // PID recycled by another process
	}
	// The executable path is a mandatory identity signal, not an
	// optional one: a record that lacks it, or a process whose
	// path cannot be read, can never be adopted — an empty path
	// is never treated as a wildcard or skipped over.
	if rt.ExecutablePath == "" || info.ExecutablePath == "" {
		return verifyUnknown, nil
	}
	if !strings.EqualFold(filepath.Clean(info.ExecutablePath), filepath.Clean(rt.ExecutablePath)) {
		return verifyNotOurs, nil // a different browser binary owns this PID
	}
	if !info.HasCommandLine {
		// The instance-folder ownership — the fact that decides
		// whether closing this process is safe — is unproven.
		return verifyUnknown, nil
	}
	absDir := filepath.Join(s.layout.Data, filepath.FromSlash(rt.UserDataDir))
	// The launch used the RESOLVED folder path; accept the
	// argument naming either the lexical or the resolved form of
	// the instance folder — each compared exactly.
	dirs := []string{absDir}
	if resolved, rerr := resolveFinalPath(absDir); rerr == nil && resolved != absDir {
		dirs = append(dirs, resolved)
	}
	uses := false
	for _, d := range dirs {
		if commandLineUsesDir(info.CommandLine, d) {
			uses = true
			break
		}
	}
	if !uses {
		return verifyNotOurs, nil
	}
	if unprovable {
		return verifyUnknown, nil
	}
	proc, err := s.launcher.Open(rt.PID, rt.ProcessCreatedAt)
	if err != nil {
		return verifyUnknown, nil
	}
	return verifyConfirmed, proc
}

// commandLineUsesDir reports whether the command line's
// --user-data-dir argument names exactly absDir. The argument is
// extracted by parsing (runner.UserDataDirArg) and the paths are
// compared whole, after cleaning, case-insensitively per Windows
// path semantics — a folder that merely shares a prefix (P-10
// vs P-1) or a path appearing in any other argument never
// matches.
func commandLineUsesDir(commandLine, absDir string) bool {
	value, ok := runner.UserDataDirArg(commandLine)
	if !ok {
		return false
	}
	return strings.EqualFold(filepath.Clean(value), filepath.Clean(absDir))
}

func (s *InstanceService) reconcileOne(c context.Context, rt model.InstanceRuntime) {
	inst, err := s.store.GetInstance(c, rt.InstanceID)
	if err != nil {
		// The instance is gone (its record should have cascaded);
		// drop the orphan record.
		_ = s.store.DeleteInstanceRuntime(c, rt.InstanceID)
		return
	}
	outcome, proc := s.verifyRecordedProcess(rt)
	switch outcome {
	case verifyConfirmed:
		w := &procWatch{proc: proc, done: make(chan struct{}), persisted: true}
		s.rtMu.Lock()
		s.procs[inst.ID] = w
		s.rtMu.Unlock()
		_ = s.store.SetInstanceStatus(c, inst.ID, model.StatusRunning)
		go s.watchProcess(inst.ID, w)
		s.noteReconcile(inst.ID, "启动时重新识别运行中的实例", logging.StatusSuccess, "")
		s.log.Info("re-attached to running browser instance", "id", inst.ID, "pid", rt.PID)
	case verifyGone, verifyNotOurs:
		_ = s.store.DeleteInstanceRuntime(c, rt.InstanceID)
		_ = s.store.SetInstanceStatus(c, inst.ID, model.StatusStopped)
		action := "启动时确认实例已关闭"
		if outcome == verifyNotOurs {
			action = "启动时确认原记录进程已不属于该实例"
		}
		s.noteReconcile(inst.ID, action, logging.StatusSuccess, "")
		s.log.Info("instance runtime record cleared at startup", "id", inst.ID, "outcome", int(outcome))
	case verifyUnknown:
		// Safe hold: the runtime record and the persisted
		// "running" status are KEPT (the process may still be
		// this instance's browser), and the instance's effective
		// status becomes "unknown" for this run — every risky
		// operation refuses on it, and the next startup
		// reconciles the record again.
		s.rtMu.Lock()
		s.unverified[inst.ID] = true
		s.rtMu.Unlock()
		s.noteReconcile(inst.ID, "启动时无法确认实例运行状态", logging.StatusFailed, "进程身份无法确认，已进入安全保持状态")
		s.log.Warn("instance process identity unconfirmed at startup", "id", inst.ID, "pid", rt.PID)
	}
}

// effectiveStatus overlays the in-memory runtime truth (tracked
// processes, in-flight transitions, unverified startup records)
// onto the persisted status.
func (s *InstanceService) effectiveStatus(inst model.Instance) model.InstanceStatus {
	s.rtMu.Lock()
	defer s.rtMu.Unlock()
	if t, ok := s.transient[inst.ID]; ok {
		return t
	}
	if _, ok := s.procs[inst.ID]; ok {
		return model.StatusRunning
	}
	if s.unverified[inst.ID] {
		return model.StatusUnknown
	}
	return inst.Status
}

// applyEffectiveStatuses rewrites the Status of each listed
// instance to its effective status.
func (s *InstanceService) applyEffectiveStatuses(list []model.Instance) {
	for i := range list {
		list[i].Status = s.effectiveStatus(list[i])
	}
}
