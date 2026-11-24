//go:build windows

package service

import (
	"errors"
	"path/filepath"
	"syscall"
)

// profileLocked reports whether a Chromium/Chrome process currently
// holds the profile directory's lockfile. Chromium keeps the file
// open with no sharing; a second exclusive open then fails with
// ERROR_SHARING_VIOLATION. This catches a browser that restarted
// itself (update / crash recovery) and is no longer the process
// DeBrowser tracks: without this check the instance looks stopped
// while a live browser still owns the profile.
func profileLocked(dir string) bool {
	path := filepath.Join(dir, "lockfile")
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	h, err := syscall.CreateFile(p,
		syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		0, // no sharing
		nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		var errno syscall.Errno
		if errors.As(err, &errno) && errno == syscall.Errno(32) { // ERROR_SHARING_VIOLATION
			return true
		}
		return false
	}
	_ = syscall.CloseHandle(h)
	return false
}
