package service

import (
	"encoding/json"
	"testing"

	"github.com/KPP69/DeBrowser/internal/capture"
	"github.com/KPP69/DeBrowser/internal/cdp"
)

// TestBindingCallFromMainWorldIsDropped pins the sync report channel:
// the Runtime binding is registered for the isolated observer world,
// and a bindingCalled event whose execution context is NOT that
// world's context must be ignored. This is what stops a page's own
// scripts from forging sync events.
func TestBindingCallFromMainWorldIsDropped(t *testing.T) {
	var got []PageEvent
	tracker := newPageTracker(nil, true, func(targetID string, ev PageEvent) {
		got = append(got, ev)
	}, nil)
	tracker.sessions["T"] = "S1"
	tracker.isoCtx["S1"] = map[int]bool{42: true} // the isolated world's context id

	payload := `{"kind":"visibility","visible":true}`
	call := func(contextID int) cdp.Event {
		raw, err := json.Marshal(map[string]any{
			"name":               capture.BindingName,
			"executionContextId": contextID,
			"payload":            payload,
		})
		if err != nil {
			t.Fatal(err)
		}
		return cdp.Event{SessionID: "S1", Params: raw}
	}

	tracker.onBindingCalled(call(7)) // page main world
	if len(got) != 0 {
		t.Fatalf("main-world binding call reached the session: %+v", got)
	}
	tracker.onBindingCalled(call(42)) // isolated observer world
	if len(got) != 1 || got[0].Kind != "visibility" {
		t.Fatalf("isolated-world binding call dropped: %+v", got)
	}
}
