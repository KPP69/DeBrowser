//go:build !windows

package service

// profileLocked is a no-op on platforms where DeBrowser does not
// track Chromium lockfiles.
func profileLocked(string) bool { return false }
