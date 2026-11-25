//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// showStartupError reports a fatal startup error in a native message
// box. The release build is a windowed executable with no console, so
// without this the user would only see "double-click did nothing".
// Best effort: a failure to show the box never changes the exit path.
func showStartupError(err error) {
	const (
		mbIconError = 0x00000010
		mbTopmost   = 0x00040000
	)
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")

	title, _ := syscall.UTF16PtrFromString("DeBrowser 启动失败")
	text, terr := syscall.UTF16PtrFromString(fmt.Sprintf(
		"%v\n\n请确认程序所在文件夹可写；详细记录见 data\\logs。", err))
	if terr != nil {
		return
	}
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(text)),
		uintptr(unsafe.Pointer(title)), uintptr(mbIconError|mbTopmost))
}
