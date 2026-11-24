package service

import (
	"github.com/KPP69/DeBrowser/internal/winmgr"
)

// defaultWindowGeometry reads placement and screen rectangle.
func defaultWindowGeometry(hwnd uintptr) (winmgr.Placement, winmgr.Rect, error) {
	pl, err := winmgr.GetPlacement(hwnd)
	if err != nil {
		return winmgr.Placement{}, winmgr.Rect{}, err
	}
	scr, err := winmgr.WindowScreenRect(hwnd)
	if err != nil {
		return winmgr.Placement{}, winmgr.Rect{}, err
	}
	return pl, scr, nil
}

func (s *SyncService) geometryOf(hwnd uintptr) (winmgr.Placement, winmgr.Rect, error) {
	if s.getWindowGeometry != nil {
		return s.getWindowGeometry(hwnd)
	}
	return defaultWindowGeometry(hwnd)
}

func (s *SyncService) applyWindowRect(hwnd uintptr, r winmgr.Rect) error {
	if s.setWindowRect != nil {
		return s.setWindowRect(hwnd, r)
	}
	return winmgr.SetWindowRect(hwnd, r)
}

func (s *SyncService) ownerPID(hwnd uintptr) int {
	if s.windowOwnerPID != nil {
		return s.windowOwnerPID(hwnd)
	}
	return winmgr.WindowOwnerPID(hwnd)
}
