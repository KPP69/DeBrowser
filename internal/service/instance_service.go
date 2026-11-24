package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/KPP69/DeBrowser/internal/database"
	"github.com/KPP69/DeBrowser/internal/logging"
	"github.com/KPP69/DeBrowser/internal/model"
	"github.com/KPP69/DeBrowser/internal/paths"
	"github.com/KPP69/DeBrowser/internal/pfiles"
	"github.com/KPP69/DeBrowser/internal/runner"
	"github.com/KPP69/DeBrowser/internal/store"
)

// InstanceService is the browser-instance management service exposed
// to the frontend over Wails bindings. It is a validating layer over
// internal/store: all SQL lives in the store, all filesystem effects
// are confined to the portable layout, and no method ever touches a
// path outside it.
//
// Status semantics (Stage 9B): model.Instance.Status is the
// PERSISTED lifecycle record, owned by the runtime manager in
// instance_runtime.go. It is written from verified process facts —
// a successful launch, an observed exit, a startup reconciliation
// that re-verified (or disproved) a recorded process — never merely
// assumed. Transient states (starting/stopping) live only in
// memory and are overlaid onto reads; a crash mid-transition
// therefore falls back to the last verified persisted state.
type InstanceService struct {
	store  *store.Store
	layout paths.Layout
	log    *slog.Logger
	// launcher starts, inspects and re-attaches browser main
	// processes. A field so tests can substitute a fake.
	launcher runner.Launcher
	// Runtime tracking (Stage 9B), guarded by rtMu: procs holds
	// the verified live process of each running instance;
	// transient holds the in-flight starting/stopping state of an
	// instance whose persisted status has not caught up yet;
	// unverified holds the instances whose recorded process could
	// not be identity-verified at startup reconciliation — their
	// effective status is "unknown" (a safe hold) while their
	// persisted status stays "running" with the runtime record
	// kept, so the next startup reconciles them again.
	rtMu       sync.Mutex
	procs      map[string]*procWatch
	transient  map[string]model.InstanceStatus
	unverified map[string]bool
	// fileMu serializes operations that decide about an instance's
	// profile folder: starting its browser, deleting/renaming the
	// folder, and reading or writing its bookmark file. The gate
	// (InstanceBookmarkAccess) and the file operation must happen
	// under the same per-instance lock, otherwise a bookmark write
	// can race a browser launch and the browser overwrites it.
	fileMu   sync.Mutex
	fileLock map[string]*sync.Mutex
	// reconcileEvents accumulates the outcomes of the startup
	// runtime reconciliation (which runs in the constructor,
	// before the Auditor is wired) so ReportReconciliation can
	// flush them into the unified record once logging is ready.
	reconcileEvents []reconcileEvent
	// auditor, when set, receives one operation-audit record per
	// user-initiated mutation (Stage 5B).
	Auditor *logging.System
	// ProxyPortFor resolves the loopback proxy port a starting
	// instance must use (0 = direct connection), or an error
	// refusing the launch when the instance is bound to a proxy
	// node but the proxy core cannot serve it. Wired by main to
	// the proxy service; nil means no proxy module, every
	// instance connects directly.
	ProxyPortFor func(instanceID string) (int, error)
	// deleteRecord removes an instance row. It is a field so tests
	// can inject a failure into the middle of
	// DeleteInstanceAndProfile and verify the profile restore.
	deleteRecord func(ctx context.Context, id string) error
	// Test seams for deterministic race injection in
	// DeleteInstanceAndProfile (nil in production): afterVerifyHook
	// runs between path verification and the object-anchored
	// quarantine move; beforeRestoreHook runs between a failed
	// record deletion and the anchored restore;
	// wipeQuarantine overrides the anchored wipe.
	afterVerifyHook   func()
	beforeRestoreHook func()
	wipeQuarantine    func(q *pfiles.Quarantine) error
}

// NewInstanceService builds the service and reconciles persisted
// instance statuses against live process facts (see
// reconcileRuntimeAtStartup). The database handle is owned by the
// caller (main) and is never closed here.
func NewInstanceService(db *database.DB, layout paths.Layout, log *slog.Logger) (*InstanceService, error) {
	return newInstanceService(db, layout, log, runner.System())
}

func newInstanceService(db *database.DB, layout paths.Layout, log *slog.Logger, launcher runner.Launcher) (*InstanceService, error) {
	s := &InstanceService{
		store:      store.New(db),
		layout:     layout,
		log:        log,
		launcher:   launcher,
		procs:      map[string]*procWatch{},
		transient:  map[string]model.InstanceStatus{},
		unverified: map[string]bool{},
		fileLock:   map[string]*sync.Mutex{},
	}
	s.deleteRecord = s.store.DeleteInstance
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.reconcileRuntimeAtStartup(ctx); err != nil {
		return nil, fmt.Errorf("instance service: %w", err)
	}
	return s, nil
}

// CreateInstanceInput carries the user-editable fields for creation
// (Stage 9B: exactly four — name, kernel, proxy node, instance
// file). There is deliberately no proxy field: the proxy-node
// association stays part of the data model, but proxy management
// is not open yet, so instances are always created unbound
// (proxy_id NULL) and can run without one.
type CreateInstanceInput struct {
	Name string `json:"name"`
	// BrowserID associates the instance with one registered
	// browser (external_browsers ID) chosen in the form. It is
	// REQUIRED: an instance must name a registered kernel before
	// it can be created (and therefore started). The association
	// is by stable ID, never by name; the instance stores the
	// registration's ID and a display snapshot of its name, and
	// the executable path is always resolved live from the
	// registration.
	BrowserID string `json:"browserId"`
	// ProfileMode selects how the instance file is provided:
	// ProfileModeDefault, ProfileModeCustom or
	// ProfileModeExisting. Empty means ProfileModeDefault.
	ProfileMode string `json:"profileMode"`
	// ProfileName is the folder name for the custom and existing
	// modes (a single directory name directly under
	// data/profiles, never a path).
	ProfileName string `json:"profileName"`
}

// UpdateInstanceInput carries the editable fields of one instance
// (Stage 9B: name, kernel, proxy node — preserved, not editable —
// and the instance file). The stored proxy_id is not editable
// here: updates preserve whatever value the row already has.
type UpdateInstanceInput struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// BrowserID is the form's registered-browser choice (see
	// CreateInstanceInput). On an instance that already has an
	// association, an empty BrowserID clears it; on an instance
	// without one, the historical free-text kernel name/version
	// recorded before associations existed are preserved verbatim.
	// Changing the association is refused while the instance is
	// running (or its state is unconfirmed).
	BrowserID string `json:"browserId"`
	SortOrder int    `json:"sortOrder"`
	// ProfileAction optionally operates on the bound instance
	// file in the same save: ProfileActionRename renames the
	// bound folder to ProfileName; ProfileActionSwap rebinds the
	// instance to the existing unbound folder ProfileName. Both
	// are refused while the instance is running (or unconfirmed).
	ProfileAction string `json:"profileAction"`
	ProfileName   string `json:"profileName"`
}

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}

// ListInstances returns all instances in display order.
func (s *InstanceService) ListInstances() ([]model.Instance, error) {
	c, cancel := ctx()
	defer cancel()
	list, err := s.store.ListInstances(c)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []model.Instance{}
	}
	s.resolveKernelPaths(c, list)
	s.applyEffectiveStatuses(list)
	return list, nil
}

// GetInstance returns one instance.
func (s *InstanceService) GetInstance(id string) (model.Instance, error) {
	c, cancel := ctx()
	defer cancel()
	in, err := s.store.GetInstance(c, id)
	if errors.Is(err, store.ErrNotFound) {
		return model.Instance{}, fmt.Errorf("实例不存在")
	}
	if err == nil {
		one := []model.Instance{in}
		s.resolveKernelPaths(c, one)
		s.applyEffectiveStatuses(one)
		in = one[0]
	}
	return in, err
}

// kernelAssociation resolves the form's registered-browser choice
// to the (kernel_id, kernel_name) pair stored on an instance: the
// registration's stable ID plus a display snapshot of its current
// name. An empty choice yields empty fields. A choice naming a
// registration that does not exist is an explicit error — never a
// silent free-text kernel record.
func (s *InstanceService) kernelAssociation(c context.Context, browserID string) (id, name string, err error) {
	browserID = strings.TrimSpace(browserID)
	if browserID == "" {
		return "", "", nil
	}
	b, err := s.store.GetExternalBrowser(c, browserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", "", fmt.Errorf("所选浏览器内核登记不存在")
		}
		return "", "", err
	}
	return b.ID, b.Name, nil
}

// resolveKernelPaths fills each instance's KernelExecutablePath
// from the registration its KernelID references — a live lookup, so
// re-selecting a registration's path is reflected on its instances
// immediately. A missing registration leaves the path empty.
func (s *InstanceService) resolveKernelPaths(c context.Context, list []model.Instance) {
	seen := map[string]string{}
	for i := range list {
		kid := list[i].KernelID
		if kid == "" {
			continue
		}
		if p, ok := seen[kid]; ok {
			list[i].KernelExecutablePath = p
			continue
		}
		p := ""
		if b, err := s.store.GetExternalBrowser(c, kid); err == nil {
			p = b.ExecutablePath
		}
		seen[kid] = p
		list[i].KernelExecutablePath = p
	}
}

// CreateInstance creates an instance (recorded, unified recording).
func (s *InstanceService) CreateInstance(operationID string, input CreateInstanceInput) (model.Instance, error) {
	op := beginOp(s.Auditor, operationID, "浏览器实例", "instance.create", "instance", "")
	inst, err := s.createInstance(input, op)
	if err != nil {
		finishOp(op, err)
		return inst, err
	}
	op.Succeed(map[string]string{"created_id": inst.ID})
	return inst, nil
}

func (s *InstanceService) createInstance(input CreateInstanceInput, op *logging.Operation) (model.Instance, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return model.Instance{}, fmt.Errorf("实例名称不能为空")
	}
	c, cancel := ctx()
	defer cancel()
	if n, err := s.store.CountInstancesByName(c, name, ""); err != nil {
		return model.Instance{}, err
	} else if n > 0 {
		return model.Instance{}, fmt.Errorf("实例名称已存在，请使用其他名称")
	}
	// A kernel is required at creation time (Stage 9B): the
	// choice must name an existing registration.
	if strings.TrimSpace(input.BrowserID) == "" {
		return model.Instance{}, fmt.Errorf("请选择实例内核")
	}
	kernelID, kernelName, err := s.kernelAssociation(c, input.BrowserID)
	if err != nil {
		return model.Instance{}, err
	}
	// Provide the instance file according to the chosen mode.
	// createdDir is the folder THIS call created (default/custom);
	// it is removed again if the database insert fails, so a
	// failed creation never leaves an orphan folder behind. The
	// existing mode creates nothing and needs no rollback.
	var dirRel, createdDir string
	switch mode := strings.TrimSpace(input.ProfileMode); mode {
	case "", ProfileModeDefault:
		folder, abs, err := s.allocateDefaultProfile(c)
		if err != nil {
			return model.Instance{}, err
		}
		dirRel, createdDir = "profiles/"+folder, abs
		op.Step("分配默认实例文件", logging.StatusSuccess, map[string]string{"profile": folder})
	case ProfileModeCustom:
		folder := input.ProfileName
		if err := s.validateProfileName(folder); err != nil {
			return model.Instance{}, err
		}
		abs, err := s.createProfileDir(c, folder)
		if err != nil {
			return model.Instance{}, err
		}
		dirRel, createdDir = "profiles/"+folder, abs
		op.Step("创建自定义实例文件", logging.StatusSuccess, map[string]string{"profile": folder})
	case ProfileModeExisting:
		canonical, err := s.requireAvailableProfile(c, strings.TrimSpace(input.ProfileName))
		if err != nil {
			return model.Instance{}, err
		}
		dirRel = "profiles/" + canonical
		op.Step("选择已有实例文件", logging.StatusSuccess, map[string]string{"profile": canonical})
	default:
		return model.Instance{}, fmt.Errorf("实例文件方式无效")
	}
	id, err := store.NewID()
	if err != nil {
		s.rollbackCreatedDir(createdDir)
		return model.Instance{}, err
	}
	created, err := s.store.CreateInstance(c, model.Instance{
		ID: id, Name: name, UserDataDir: dirRel, // ProxyID stays nil: no proxy nodes exist to bind yet
		KernelID:   kernelID,
		KernelName: kernelName,
	})
	if err != nil {
		s.rollbackCreatedDir(createdDir)
		return model.Instance{}, mapConstraintError(err)
	}
	one := []model.Instance{created}
	s.resolveKernelPaths(c, one)
	created = one[0]
	s.log.Info("instance created", "id", created.ID, "name", created.Name, "dir", dirRel)
	return created, nil
}

// UpdateInstance updates an instance (recorded, unified recording).
func (s *InstanceService) UpdateInstance(operationID string, input UpdateInstanceInput) (model.Instance, error) {
	op := beginOp(s.Auditor, operationID, "浏览器实例", "instance.update", "instance", input.ID)
	inst, err := s.updateInstance(input, op)
	finishOp(op, err)
	return inst, err
}

func (s *InstanceService) updateInstance(input UpdateInstanceInput, op *logging.Operation) (model.Instance, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return model.Instance{}, fmt.Errorf("实例名称不能为空")
	}
	c, cancel := ctx()
	defer cancel()
	current, err := s.store.GetInstance(c, input.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return model.Instance{}, fmt.Errorf("实例不存在")
		}
		return model.Instance{}, err
	}
	if n, err := s.store.CountInstancesByName(c, name, input.ID); err != nil {
		return model.Instance{}, err
	} else if n > 0 {
		return model.Instance{}, fmt.Errorf("实例名称已存在，请使用其他名称")
	}

	// Work out what this save changes beyond the display name.
	kernelChange := strings.TrimSpace(input.BrowserID) != current.KernelID
	profileAction := strings.TrimSpace(input.ProfileAction)
	if profileAction != ProfileActionNone && profileAction != ProfileActionRename && profileAction != ProfileActionSwap {
		return model.Instance{}, fmt.Errorf("实例文件操作无效")
	}
	// Instance-file changes are refused unless the instance is
	// verifiably at rest: renaming or rebinding the folder under
	// a running browser — or one whose state cannot be
	// confirmed — could corrupt its data or strand its process.
	// Only operations that can endanger the profile folder are
	// gated this way.
	if profileAction != ProfileActionNone {
		switch s.effectiveStatus(current) {
		case model.StatusStopped, model.StatusError:
		case model.StatusUnknown:
			return model.Instance{}, fmt.Errorf("实例运行状态无法确认，不能更换实例文件")
		default:
			return model.Instance{}, fmt.Errorf("实例正在运行，不能更换实例文件")
		}
	}
	// A kernel change is metadata, like the display name: it
	// takes effect at the next launch and never acts on a
	// running process — the runtime record keeps the path the
	// browser was launched with, and no launch is possible
	// while the state is unconfirmed. It is refused only while
	// the instance is actually running or transitioning.
	if kernelChange {
		switch s.effectiveStatus(current) {
		case model.StatusRunning, model.StatusStarting, model.StatusStopping:
			return model.Instance{}, fmt.Errorf("实例正在运行，不能更换内核")
		}
	}

	updated := current
	updated.Name = name
	// updated.ProxyID and updated.StartURL are intentionally left
	// untouched: the stored proxy binding is data compatibility
	// (proxy management is not open yet), and the start URL is not
	// one of the four editable fields.
	switch {
	case strings.TrimSpace(input.BrowserID) != "":
		kernelID, kernelName, kerr := s.kernelAssociation(c, input.BrowserID)
		if kerr != nil {
			return model.Instance{}, kerr
		}
		updated.KernelID = kernelID
		updated.KernelName = kernelName
		updated.KernelVersion = ""
	case current.KernelID != "":
		// The form's empty choice explicitly clears an existing
		// association.
		updated.KernelID = ""
		updated.KernelName = ""
		updated.KernelVersion = ""
	default:
		// No association and none chosen: historical free-text
		// kernel name/version recorded before associations existed
		// stay untouched — an unrelated edit never drops them.
	}
	updated.SortOrder = input.SortOrder

	// Instance-file operations run BEFORE the database write; a
	// failed write rolls the filesystem back, so the record and
	// the folder can never disagree about the binding.
	var rollback func() error
	switch profileAction {
	case ProfileActionRename:
		newDir, rb, rerr := s.renameProfileDir(c, current, input.ProfileName)
		if rerr != nil {
			return model.Instance{}, rerr
		}
		updated.UserDataDir = newDir
		rollback = rb
		op.Step("重命名实例文件", logging.StatusSuccess, map[string]string{
			"from": profileFolder(current.UserDataDir), "to": profileFolder(newDir),
		})
	case ProfileActionSwap:
		canonical, serr := s.requireAvailableProfile(c, strings.TrimSpace(input.ProfileName))
		if serr != nil {
			return model.Instance{}, serr
		}
		updated.UserDataDir = "profiles/" + canonical
		op.Step("更换实例文件", logging.StatusSuccess, map[string]string{
			"from": profileFolder(current.UserDataDir), "to": canonical,
		})
	}

	saved, err := s.store.UpdateInstance(c, updated)
	if err != nil {
		if rollback != nil {
			if rerr := rollback(); rerr != nil {
				// The folder moved but the record could not
				// follow, and the move-back failed too: surface
				// the inconsistency loudly instead of hiding it.
				_ = s.store.SetInstanceStatus(c, current.ID, model.StatusError)
				return model.Instance{}, fmt.Errorf("保存实例失败，且实例文件恢复失败（记录与文件夹可能不一致，请勿启动该实例）：%w", err)
			}
		}
		return model.Instance{}, mapConstraintError(err)
	}
	one := []model.Instance{saved}
	s.resolveKernelPaths(c, one)
	s.applyEffectiveStatuses(one)
	return one[0], nil
}

// mapConstraintError turns SQLite constraint failures into messages
// the UI can show directly.
func mapConstraintError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "UNIQUE constraint failed: browser_instances.name"):
		return fmt.Errorf("实例名称已存在，请换一个名称")
	case strings.Contains(msg, "UNIQUE constraint failed: browser_instances.user_data_dir"):
		return fmt.Errorf("该数据目录已被其他实例占用")
	case strings.Contains(msg, "FOREIGN KEY constraint failed"):
		return fmt.Errorf("关联数据不存在或已被删除")
	default:
		return err
	}
}
