package service

// SyncParticipantView is one instance's state in the UI.
type SyncParticipantView struct {
	InstanceID string `json:"instanceId"`
	Name       string `json:"name"`
	Role       string `json:"role"`   // master / follower / ""
	Status     string `json:"status"` // 同步中 / 已暂停 / 失败 / 未参与
	Reason     string `json:"reason"`
}

// SyncStateView is the whole synchronization state for the UI.
type SyncStateView struct {
	Phase        string                `json:"phase"` // 已停止 / 启动中 / 同步中 / 已暂停 / 停止中
	MasterID     string                `json:"masterId"`
	MasterName   string                `json:"masterName"`
	ManualStop   bool                  `json:"-"`
	Participants []SyncParticipantView `json:"participants"`
	// MirrorActive reports whether master window mirroring is
	// running this session.
	MirrorActive bool `json:"mirrorActive"`
}

// SyncCandidate is one instance's synchronization capability.
type SyncCandidate struct {
	InstanceID   string `json:"instanceId"`
	Name         string `json:"name"`
	KernelName   string `json:"kernelName"`
	Running      bool   `json:"running"`
	Verified     bool   `json:"verified"`
	CDPAvailable bool   `json:"cdpAvailable"`
	Reason       string `json:"reason"`
}

// GetSyncCandidates lists every instance with its sync
// capability, straight from the instance runtime.
func (s *SyncService) GetSyncCandidates(operationID string) ([]SyncCandidate, error) {
	op := beginOp(s.Auditor, operationID, "sync", "candidates", "", "")
	list, err := s.instances.ListInstances()
	if err != nil {
		finishOp(op, err)
		return nil, err
	}
	out := make([]SyncCandidate, 0, len(list))
	for _, inst := range list {
		c := SyncCandidate{InstanceID: inst.ID, Name: inst.Name, KernelName: inst.KernelName}
		info, ok := s.instances.SyncRuntimeInfo(inst.ID)
		switch {
		case !ok:
			c.Reason = "实例不存在"
		case !info.Running:
			c.Reason = "实例未运行"
		case !info.Verified:
			c.Reason = "实例运行状态无法确认"
		case info.CDPPort == 0:
			c.Reason = "实例没有可用的调试端口，请重新启动该实例"
		default:
			c.Running, c.Verified, c.CDPAvailable = true, true, true
		}
		out = append(out, c)
	}
	finishOp(op, nil)
	return out, nil
}
