//go:build windows

package service

import "syscall"

// isReparsePoint reports whether path itself is a reparse point
// (symbolic link, junction/mount point, or any other reparse tag).
// os.Lstat alone is not enough on Windows: a junction may not carry
// os.ModeSymlink, but it still redirects every operation below it.
func isReparsePoint(path string) bool {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attrs, err := syscall.GetFileAttributes(p)
	if err != nil {
		return false
	}
	return attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}
