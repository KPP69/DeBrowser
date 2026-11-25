package service

import (
	"github.com/KPP69/DeBrowser/internal/model"
	"net"
	"path/filepath"
)

// allocateCDPPort reserves an ephemeral TCP port on the
// loopback interface and releases it for the browser to bind.
// The small race between release and the browser's bind is
// inherent to port hand-off; a lost race makes the browser run
// without a debugging endpoint, which synchronization detects
// and reports — it never breaks the launch.
func allocateCDPPort() int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0
	}
	defer ln.Close()
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

// SyncRuntimeInfo is the verified runtime identity of one
// instance for the synchronization module (Stage 10). It is the
// ONLY channel through which sync learns about processes: sync
// never scans for processes or ports itself.
type SyncRuntimeInfo struct {
	InstanceID string
	Running    bool
	// Verified is true when a tracked process exists and its
	// recorded identity is complete.
	Verified        bool
	PID             int
	ProcessCreateAt int64
	ExecutablePath  string
	UserDataDir     string // absolute profile directory
	CDPPort         int    // 0 = no DeBrowser-assigned CDP port
}

// SyncRuntimeInfo returns the instance's current runtime
// identity, re-verifying the tracked process against the
// persisted runtime record. ok=false means the instance does
// not exist. A process whose identity cannot be fully verified
// reports Verified=false and must not join synchronization.
func (s *InstanceService) SyncRuntimeInfo(id string) (SyncRuntimeInfo, bool) {
	c, cancel := ctx()
	defer cancel()
	inst, err := s.store.GetInstance(c, id)
	if err != nil {
		return SyncRuntimeInfo{}, false
	}
	info := SyncRuntimeInfo{InstanceID: id}
	if s.effectiveStatus(inst) != model.StatusRunning {
		return info, true
	}
	s.rtMu.Lock()
	w := s.procs[id]
	s.rtMu.Unlock()
	if w == nil || w.proc == nil {
		// Running per the record but not tracked by this
		// process (e.g. re-adopted bookkeeping without a live
		// watch): identity is not verifiable here.
		return info, true
	}
	rt, err := s.store.GetInstanceRuntime(c, id)
	if err != nil || rt.ProcessCreatedAt == 0 {
		return info, true
	}
	if w.proc.PID() != rt.PID || w.proc.CreatedAt() != rt.ProcessCreatedAt {
		return info, true
	}
	info.Running = true
	info.Verified = true
	info.PID = rt.PID
	info.ProcessCreateAt = rt.ProcessCreatedAt
	info.ExecutablePath = rt.ExecutablePath
	info.UserDataDir = filepath.Join(s.layout.Data, filepath.FromSlash(inst.UserDataDir))
	info.CDPPort = w.cdpPort
	return info, true
}

// VerifySyncIdentity re-checks that the process identified by a
// previously obtained SyncRuntimeInfo is still the tracked
// process of the instance (PID + creation time + executable
// path). Used before window operations and on session resume.
func (s *InstanceService) VerifySyncIdentity(info SyncRuntimeInfo) bool {
	if !info.Verified || info.PID <= 0 {
		return false
	}
	s.rtMu.Lock()
	w := s.procs[info.InstanceID]
	s.rtMu.Unlock()
	if w == nil || w.proc == nil {
		return false
	}
	return w.proc.PID() == info.PID && w.proc.CreatedAt() == info.ProcessCreateAt
}
