package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/pfiles"
	"github.com/KPP69/DeBrowser/internal/store"
)

// requireInstanceAtRest gates destructive or rebinding operations:
// the instance must be verifiably at rest. A running (or starting/
// stopping) instance refuses outright; an instance whose runtime
// state cannot be confirmed also refuses — acting on an
// unconfirmed browser could endanger its data.
func (s *InstanceService) requireInstanceAtRest(inst model.Instance, action string) error {
	switch s.effectiveStatus(inst) {
	case model.StatusStopped, model.StatusError:
		// A browser that restarted itself (update or crash
		// recovery) is no longer the tracked process, so the
		// status says stopped while a live browser still owns
		// the profile. Refuse when its lockfile is held.
		if folder := profileFolder(inst.UserDataDir); folder != "" &&
			profileLocked(filepath.Join(s.layout.Profiles, folder)) {
			return fmt.Errorf("实例文件正被浏览器占用（可能是浏览器自行重启），请先关闭该实例的浏览器")
		}
		return nil
	case model.StatusUnknown:
		return fmt.Errorf("实例运行状态无法确认，不能%s", action)
	default:
		return fmt.Errorf("实例正在运行，不能%s", action)
	}
}

// DeleteInstance removes ONLY the instance's metadata (and, via the
// schema cascade, its bookmarks). The profile directory on disk is
// deliberately left untouched: browser data is never deleted as a
// side effect of removing a record.
// DeleteInstance deletes instance metadata only (recorded,
// unified recording).
func (s *InstanceService) DeleteInstance(operationID string, id string) error {
	op := beginOp(s.Auditor, operationID, "浏览器实例", "instance.delete", "instance", id)
	err := s.deleteInstance(id)
	finishOp(op, err)
	return err
}

func (s *InstanceService) deleteInstance(id string) error {
	c, cancel := ctx()
	defer cancel()
	inst, err := s.store.GetInstance(c, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("实例不存在")
		}
		return err
	}
	if err := s.requireInstanceAtRest(inst, "删除"); err != nil {
		return err
	}
	if err := s.store.DeleteInstance(c, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("实例不存在")
		}
		return err
	}
	s.log.Info("instance metadata deleted (profile files kept)", "id", id)
	return nil
}

// DeleteInstanceAndProfile is the explicit, destructive counterpart
// of DeleteInstance: it removes the profile directory AND the
// metadata. It is structured so no failure loses data silently:
//
//  1. The stored path is proven safe (verifiedProfileTarget: the
//     directory itself is not a link, and its fully resolved real
//     path lies strictly inside the profiles directory).
//  2. internal/pfiles moves the VERIFIED OBJECT — not the path
//     string — into a quarantine slot under profiles: Linux anchors
//     the move to directory fds (openat O_NOFOLLOW descent +
//     renameat2 NOREPLACE between pinned fds, with a post-move
//     identity check), Windows renames through the target's own
//     directory handle after verifying the handle's identity.
//     Swapping any path component after step 1 therefore cannot
//     redirect the move to an outside directory; anything that
//     cannot be anchored is refused with data and record intact.
//  3. The database record is deleted. If that fails, the object is
//     moved back through the same anchor — the operation aborts
//     with the profile and the record both intact.
//  4. Only with the record gone is the quarantine tree wiped by
//     anchored deletion (internal/safedelete). A wipe failure
//     leaves the data in the quarantine slot — reported in the
//     error, never silently lost.
//
// An instance that is running (or whose runtime state cannot
// be confirmed) is refused before any of this.
// DeleteInstanceAndProfile deletes an instance and its profile
// directory (recorded with per-phase steps, unified recording).
func (s *InstanceService) DeleteInstanceAndProfile(operationID string, id string) error {
	op := beginOp(s.Auditor, operationID, "浏览器实例", "instance.delete_with_profile", "instance", id)
	err := s.deleteInstanceAndProfile(id, op)
	finishOp(op, err)
	return err
}

func (s *InstanceService) deleteInstanceAndProfile(id string, op *logging.Operation) error {
	c, cancel := ctx()
	defer cancel()
	// Hold the instance's file lock for the whole destruction: a
	// bookmark write must never run against a folder being deleted.
	unlock := s.lockInstanceFiles(id)
	defer unlock()
	in, err := s.store.GetInstance(c, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("实例不存在")
		}
		return err
	}
	if err := s.requireInstanceAtRest(in, "删除"); err != nil {
		return err
	}
	target, err := s.verifiedProfileTarget(in.UserDataDir)
	if err != nil {
		op.Step("校验 Profile 路径", logging.StatusFailed, nil)
		return err
	}
	op.Step("校验 Profile 路径", logging.StatusSuccess, nil)
	if target == "" {
		// Nothing on disk: only the record needs to go.
		if err := s.store.DeleteInstance(c, id); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("实例不存在")
			}
			return err
		}
		op.Step("删除数据库记录", logging.StatusSuccess, nil)
		s.log.Info("instance deleted (no profile directory on disk)", "id", id)
		return nil
	}
	if s.afterVerifyHook != nil {
		s.afterVerifyHook()
	}

	q, err := s.moveToQuarantine(target)
	if err != nil {
		op.Step("移动 Profile 到隔离区", logging.StatusFailed, nil)
		return err
	}
	op.Step("移动 Profile 到隔离区", logging.StatusSuccess, nil)
	defer func() { _ = q.Close() }()

	if err := s.deleteRecord(c, id); err != nil {
		op.Step("删除数据库记录", logging.StatusFailed, nil)
		// Restore the object to its original location through the
		// same anchor; the operation must leave the world exactly
		// as it found it.
		if s.beforeRestoreHook != nil {
			s.beforeRestoreHook()
		}
		if rerr := q.Restore(); rerr != nil {
			return fmt.Errorf("删除实例记录失败，且 Profile 目录恢复失败（数据保留在隔离目录 %s）：%w", q.Path(), err)
		}
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("实例不存在")
		}
		return err
	}
	op.Step("删除数据库记录", logging.StatusSuccess, nil)
	wipe := s.wipeQuarantine
	if wipe == nil {
		wipe = func(q *pfiles.Quarantine) error { return q.Wipe() }
	}
	if err := wipe(q); err != nil {
		op.Step("安全擦除 Profile 数据", logging.StatusFailed, nil)
		return fmt.Errorf("实例记录已删除，但 Profile 数据清理不完全（残留在隔离目录 %s）：%w", q.Path(), err)
	}
	op.Step("安全擦除 Profile 数据", logging.StatusSuccess, nil)
	s.log.Info("instance and profile deleted", "id", id, "dir", in.UserDataDir)
	return nil
}

// moveToQuarantine moves target into a fresh quarantine slot,
// retrying with another slot name when a name turns out to be
// occupied (the platform move never overwrites an occupant).
func (s *InstanceService) moveToQuarantine(target string) (*pfiles.Quarantine, error) {
	for attempt := 0; attempt < 3; attempt++ {
		id, err := store.NewID()
		if err != nil {
			return nil, err
		}
		q, err := pfiles.MoveToQuarantine(s.layout.Profiles, target, ".debrowser-quarantine-"+id)
		if err == nil {
			return q, nil
		}
		if errors.Is(err, pfiles.ErrOccupied) {
			continue
		}
		if errors.Is(err, pfiles.ErrUnsafe) {
			return nil, fmt.Errorf("无法证明 Profile 目录可被安全隔离，已拒绝删除：%w", err)
		}
		return nil, fmt.Errorf("隔离 Profile 目录失败：%w", err)
	}
	return nil, fmt.Errorf("无法分配隔离目录")
}

// verifiedProfileTarget proves that the stored profile path is safe
// to delete and returns the RESOLVED absolute path to remove (""
// when nothing exists on disk). String containment is only the first
// gate; the real proof is filesystem-based:
//
//  1. The lexical target must be strictly inside the profiles dir.
//  2. The target itself must not be a symbolic link / reparse point
//     (deleting "through" it is refused outright, wherever it aims).
//  3. resolveFinalPath resolves EVERY component — intermediate
//     symlinks and Windows junctions/reparse points included
//     (EvalSymlinks on Unix, GetFinalPathNameByHandle on Windows,
//     where EvalSymlinks alone misses a junction that is the final
//     component) — and the resolved target must still be strictly
//     inside the resolved profiles directory. Anything that cannot
//     be proven inside is refused.
//
// Deleting the resolved path (rather than the lexical one) keeps the
// verified location and the deleted location identical.
func (s *InstanceService) verifiedProfileTarget(stored string) (string, error) {
	target := filepath.Join(s.layout.Data, filepath.FromSlash(stored))
	cleanTarget := filepath.Clean(target)
	cleanProfiles := filepath.Clean(s.layout.Profiles)
	if cleanTarget == cleanProfiles || !strings.HasPrefix(cleanTarget, cleanProfiles+string(os.PathSeparator)) {
		return "", fmt.Errorf("拒绝删除：目标路径不在 profiles 目录之内")
	}
	info, err := os.Lstat(cleanTarget)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil // nothing on disk: nothing to protect
		}
		return "", fmt.Errorf("拒绝删除：无法检查目标路径：%w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(cleanTarget) {
		return "", fmt.Errorf("拒绝删除：Profile 目录本身是符号链接")
	}
	resolvedProfiles, err := resolveFinalPath(cleanProfiles)
	if err != nil {
		return "", fmt.Errorf("拒绝删除：无法解析 profiles 目录：%w", err)
	}
	resolvedTarget, err := resolveFinalPath(cleanTarget)
	if err != nil {
		return "", fmt.Errorf("拒绝删除：无法解析目标真实路径：%w", err)
	}
	if resolvedTarget == resolvedProfiles || !strings.HasPrefix(resolvedTarget, resolvedProfiles+string(os.PathSeparator)) {
		return "", fmt.Errorf("拒绝删除：目标真实路径不在 profiles 目录之内")
	}
	return resolvedTarget, nil
}
