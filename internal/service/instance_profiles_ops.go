package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/KPP69/DeBrowser/internal/model"
)

// Instance-file (profile directory) creation modes for
// CreateInstanceInput.ProfileMode (Stage 9B).
const (
	// ProfileModeDefault allocates the next sequential folder
	// name P-1, P-2, ... from the persistent profile counter and
	// creates the folder.
	ProfileModeDefault = "default"
	// ProfileModeCustom creates a NEW folder with the
	// user-supplied name in ProfileName.
	ProfileModeCustom = "custom"
	// ProfileModeExisting binds an existing, currently unbound
	// folder named by ProfileName without copying anything.
	ProfileModeExisting = "existing"
)

// Instance-file actions for UpdateInstanceInput.ProfileAction.
const (
	// ProfileActionNone leaves the bound instance file untouched.
	ProfileActionNone = ""
	// ProfileActionRename renames the bound folder itself to
	// ProfileName (a move, never a copy; data stays in place).
	ProfileActionRename = "rename"
	// ProfileActionSwap rebinds the instance to the existing
	// unbound folder named by ProfileName; the previously bound
	// folder stays on disk, unbound.
	ProfileActionSwap = "swap"
)

// rollbackCreatedDir removes a profile folder a failed creation
// had just made. Only ever called with a folder this service
// created moments ago (empty by construction); removal uses
// os.Remove, which refuses a non-empty directory — a folder that
// somehow gained content is left in place rather than destroyed.
func (s *InstanceService) rollbackCreatedDir(abs string) {
	if abs == "" {
		return
	}
	if err := os.Remove(abs); err != nil {
		s.log.Warn("rollback of a newly created profile directory failed", "dir", abs, "error", err)
	}
}

// renameProfileDir renames the instance's bound folder to newName
// and returns the new stored user_data_dir plus a rollback that
// undoes the filesystem move. Rules: the target must be a valid
// folder name, free (not bound, not on disk — Windows
// case-insensitively), and the move itself is a plain rename of
// the verified folder inside data/profiles: no copy, no merge, no
// data loss. When the bound folder does not exist on disk yet
// (the instance was never started), an empty folder is created at
// the new name instead — there is no data to move.
func (s *InstanceService) renameProfileDir(c context.Context, inst model.Instance, newName string) (string, func() error, error) {
	// The move must not race a bookmark read/write or a launch.
	unlock := s.lockInstanceFiles(inst.ID)
	defer unlock()
	if err := s.validateProfileName(newName); err != nil {
		return "", nil, err
	}
	oldFolder := profileFolder(inst.UserDataDir)
	if oldFolder == "" {
		return "", nil, fmt.Errorf("实例文件路径异常，无法重命名")
	}
	if foldName(oldFolder) == foldName(newName) && oldFolder != newName {
		// A case-only rename is a real rename on Windows too;
		// fall through and let the OS do it.
	} else if oldFolder == newName {
		return inst.UserDataDir, func() error { return nil }, nil
	}
	taken, err := s.profileFolderTaken(c, newName, foldName(oldFolder))
	if err != nil {
		return "", nil, err
	}
	if taken {
		return "", nil, fmt.Errorf("目标实例文件名称 %q 已存在，无法重命名", newName)
	}
	src := filepath.Join(s.layout.Profiles, oldFolder)
	dst := filepath.Join(s.layout.Profiles, newName)
	_, lerr := os.Lstat(src)
	switch {
	case lerr == nil:
		// The folder exists: it must be a real directory inside
		// the managed root, never a link out of it.
		if _, verr := s.verifiedProfileTarget(inst.UserDataDir); verr != nil {
			return "", nil, fmt.Errorf("实例文件无法安全访问：%w", verr)
		}
		if err := os.Rename(src, dst); err != nil {
			return "", nil, fmt.Errorf("重命名实例文件失败：%w", err)
		}
		return "profiles/" + newName, func() error { return os.Rename(dst, src) }, nil
	case errors.Is(lerr, os.ErrNotExist):
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return "", nil, fmt.Errorf("重命名实例文件失败：%w", err)
		}
		return "profiles/" + newName, func() error { return os.Remove(dst) }, nil
	default:
		return "", nil, fmt.Errorf("实例文件无法访问：%w", lerr)
	}
}

// validateProfileComponent checks one profile directory name
// component against the Windows reinterpretation rules: NTFS
// alternate data streams (':'), trailing dot/space aliasing,
// reserved device names, and smuggled separators are all refused
// up front rather than discovered later.
func validateProfileComponent(comp string) error {
	if comp == "" || comp == "." || comp == ".." {
		return fmt.Errorf("数据目录包含无效的路径组件")
	}
	if strings.ContainsAny(comp, "<>:\"|?*\\") {
		return fmt.Errorf("数据目录组件 %q 包含不允许的字符", comp)
	}
	for _, r := range comp {
		if r < 0x20 {
			return fmt.Errorf("数据目录组件 %q 包含控制字符", comp)
		}
	}
	if strings.HasSuffix(comp, ".") || strings.HasSuffix(comp, " ") {
		return fmt.Errorf("数据目录组件 %q 不能以点或空格结尾", comp)
	}
	base := comp
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	switch strings.ToUpper(base) {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
		// Microsoft's naming rules also reserve the superscript
		// forms: Windows treats the ISO/IEC 8859-1 superscript
		// digits ¹ ² ³ as digits in COM#/LPT# device names.
		"COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³":
		return fmt.Errorf("数据目录组件 %q 是 Windows 保留设备名", comp)
	}
	return nil
}
