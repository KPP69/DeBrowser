package service

import (
	"encoding/json"
	"testing"

	"github.com/KPP69/DeBrowser/internal/capture"
	"github.com/KPP69/DeBrowser/internal/cdp"
)

// TestSyncBindingContextSet pins the set-based isolated-world
// filter in sync_page.go: a bindingCalled report is accepted
// only when its execution context ID is in the recorded set for
// its session. Contexts are recorded by onContextCreated for
// every isolated world of the sync world (main frame and
// sub-frames alike), and a navigation simply adds the fresh
// context — the old single-ID record dropped every report after
// the first full navigation of the master page.
//
// All six cases call the handlers directly; no browser runs.
func TestSyncBindingContextSet(t *testing.T) {
	newTracker := func() (*pageTracker, *[]PageEvent) {
		var got []PageEvent
		tracker := newPageTracker(nil, true, func(targetID string, ev PageEvent) {
			got = append(got, ev)
		}, nil)
		tracker.sessions["T"] = "S1"
		return tracker, &got
	}
	bindingCall := func(contextID int) cdp.Event {
		raw, err := json.Marshal(map[string]any{
			"name":               capture.BindingName,
			"executionContextId": contextID,
			"payload":            `{"kind":"visibility","visible":true}`,
		})
		if err != nil {
			t.Fatal(err)
		}
		return cdp.Event{SessionID: "S1", Params: raw}
	}
	contextCreated := func(contextID int, isMain bool, frameID string) cdp.Event {
		raw, err := json.Marshal(map[string]any{
			"context": map[string]any{
				"id":   contextID,
				"name": syncWorldName,
				"auxData": map[string]any{
					"frameId": frameID,
					"isMain":  isMain,
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return cdp.Event{SessionID: "S1", Params: raw}
	}

	t.Run("registered isolated context is accepted", func(t *testing.T) {
		tracker, got := newTracker()
		tracker.onContextCreated(contextCreated(11, true, "F1"))
		tracker.onBindingCalled(bindingCall(11))
		if len(*got) != 1 || (*got)[0].Kind != "visibility" {
			t.Fatalf("registered context 11 dropped: %+v", *got)
		}
	})

	t.Run("unregistered context is dropped", func(t *testing.T) {
		tracker, got := newTracker()
		tracker.onBindingCalled(bindingCall(99))
		if len(*got) != 0 {
			t.Fatalf("unregistered context 99 reached the session: %+v", *got)
		}
	})

	t.Run("main-world context is dropped", func(t *testing.T) {
		tracker, got := newTracker()
		tracker.onContextCreated(contextCreated(11, true, "F1"))
		tracker.onBindingCalled(bindingCall(10)) // main world, never registered
		if len(*got) != 0 {
			t.Fatalf("main-world context 10 reached the session: %+v", *got)
		}
	})

	t.Run("context after navigation is accepted", func(t *testing.T) {
		tracker, got := newTracker()
		tracker.onContextCreated(contextCreated(11, true, "F1"))
		// First full navigation: the browser reports a fresh
		// isolated-world context for the same session.
		tracker.onContextCreated(contextCreated(12, true, "F1"))
		tracker.onBindingCalled(bindingCall(12))
		if len(*got) != 1 || (*got)[0].Kind != "visibility" {
			t.Fatalf("post-navigation context 12 dropped: %+v", *got)
		}
	})

	t.Run("sub-frame isolated context is accepted", func(t *testing.T) {
		tracker, got := newTracker()
		tracker.onContextCreated(contextCreated(13, false, "F2"))
		tracker.onBindingCalled(bindingCall(13))
		if len(*got) != 1 || (*got)[0].Kind != "visibility" {
			t.Fatalf("sub-frame context 13 dropped: %+v", *got)
		}
	})

	t.Run("report after Forget is dropped", func(t *testing.T) {
		tracker, got := newTracker()
		tracker.onContextCreated(contextCreated(11, true, "F1"))
		tracker.Forget("T")
		tracker.onBindingCalled(bindingCall(11))
		if len(*got) != 0 {
			t.Fatalf("report after Forget reached the session: %+v", *got)
		}
	})
}
