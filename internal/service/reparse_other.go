//go:build !windows

package service

// isReparsePoint is a no-op on platforms where the portable layout
// check relies on os.ModeSymlink alone.
func isReparsePoint(string) bool { return false }
