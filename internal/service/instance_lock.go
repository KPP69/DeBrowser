package service

import (
	"sync"

	"github.com/KPP69/DeBrowser/internal/model"
)

// lockInstanceFiles takes the per-instance lock that serializes every
// decision about an instance's profile folder. The returned function
// releases it and must always be called.
//
// Lock order: instance file lock first, runtime lock (rtMu) second.
// Start, delete, rename and bookmark file access all follow it, so
// the gate check and the file operation can no longer interleave with
// a browser launch.
func (s *InstanceService) lockInstanceFiles(id string) func() {
	s.fileMu.Lock()
	mu, ok := s.fileLock[id]
	if !ok {
		mu = &sync.Mutex{}
		s.fileLock[id] = mu
	}
	s.fileMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

// lockBookmarkAccess acquires the instance's file lock and then runs
// the bookmark gate, so callers can hold the returned unlock for the
// whole read/write of the Bookmarks file. The gate result is the SOLE
// decision input: holding the lock does not by itself allow access.
// When the gate is not "stopped", the lock is released before
// returning and unlock is nil.
func (s *InstanceService) lockBookmarkAccess(id string) (unlock func(), inst model.Instance, dir, gate string, err error) {
	unlock = s.lockInstanceFiles(id)
	inst, dir, gate, err = s.InstanceBookmarkAccess(id)
	if err != nil || gate != BookmarkGateStopped {
		unlock()
		return nil, inst, dir, gate, err
	}
	return unlock, inst, dir, gate, nil
}
