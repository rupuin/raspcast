package player

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/rupuin/raspcast/server/mpv"
)

type fakeController struct {
	startedWith string
	commands    [][]any
	stopCalls   int
}

func (f *fakeController) Start(url string) error {
	f.startedWith = url
	return nil
}

func (f *fakeController) Stop() {
	f.stopCalls++
}

func (f *fakeController) Send(cmd []any) {
	f.commands = append(f.commands, cmd)
}

func newTestPlayer(t *testing.T) (*Player, chan mpv.Event, *fakeController) {
	t.Helper()
	ctrlEvents := make(chan mpv.Event, 16)
	fc := &fakeController{}
	p := New(fc, ctrlEvents)
	t.Cleanup(p.Shutdown)
	return p, ctrlEvents, fc
}

func newStreamingPlayer(t *testing.T) (*Player, chan mpv.Event, *fakeController) {
	t.Helper()
	p, ctrlEvents, fc := newTestPlayer(t)
	if err := p.Play("https://video"); err != nil {
		t.Fatalf("Play returned error: %v", err)
	}

	ctrlEvents <- mpv.Event{Kind: mpv.Ready}

	select {
	case e := <-p.Events:
		if e.Kind != Streaming {
			t.Fatalf("expected Streaming event, got %v", e.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for streaming event")
	}

	return p, ctrlEvents, fc
}

func syncPlayer(p *Player) {
	p.Snapshot()
}

func TestControllerEvents_EmitPlayerEvents(t *testing.T) {
	testCases := []struct {
		name      string
		ctrlEvent mpv.Event
		wantEvent Event
	}{
		{"emits Position", mpv.Event{Kind: mpv.Property, Name: "time-pos", Value: 12.3}, Event{Kind: Position, Value: 12.3}},
		{"emits Duration", mpv.Event{Kind: mpv.Property, Name: "duration", Value: 300.442}, Event{Kind: Duration, Value: 300.442}},
		{"emits Volume", mpv.Event{Kind: mpv.Property, Name: "volume", Value: 75.0}, Event{Kind: Volume, Value: 75.0}},
		{"emits Paused true when paused", mpv.Event{Kind: mpv.Property, Name: "pause", Value: true}, Event{Kind: Paused, Value: true}},
		{"emits Paused false when unpaused", mpv.Event{Kind: mpv.Property, Name: "pause", Value: false}, Event{Kind: Paused, Value: false}},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			p, ctrlEvents, _ := newTestPlayer(t)

			ctrlEvents <- tc.ctrlEvent

			select {
			case e := <-p.Events:
				if e.Kind != tc.wantEvent.Kind {
					t.Errorf("expected event kind %q, got: %q", tc.wantEvent.Kind, e.Kind)
				}
				if !reflect.DeepEqual(e.Value, tc.wantEvent.Value) {
					t.Errorf("expected event value %q, got: %q", tc.wantEvent.Value, e.Value)
				}
			case <-time.After(time.Second):
				t.Fatalf("timed out waiting for message")
			}
		})
	}

}

func TestPlay_EmitsStreaming(t *testing.T) {
	p, ctrlEvents, fc := newTestPlayer(t)

	if err := p.Play("https://video"); err != nil {
		t.Fatalf("Play returned error: %v", err)
	}

	ctrlEvents <- mpv.Event{Kind: mpv.Ready}
	select {
	case e := <-p.Events:
		if e.Kind != Streaming {
			t.Errorf("expected Streaming event, got: %v", e.Kind)
		}
		if e.Value != fc.startedWith {
			t.Errorf("expected event Value %v, got: %v", fc.startedWith, e.Value)
		}
	case <-time.After(time.Second):
		t.Fatalf("timeout waiting for message")
	}
}

func TestPlay_ReturnsErrOnEmptyURL(t *testing.T) {
	p, _, _ := newTestPlayer(t)
	err := p.Play("")
	if err == nil {
		t.Error("expected error for empty url")
	}
}

func TestActions_SendCorrectMpvCommand(t *testing.T) {
	testCases := []struct {
		name    string
		call    func(p *Player)
		wantCmd []any
	}{
		{"Pause sends cycle pause", func(p *Player) { p.Pause() }, []any{"cycle", "pause"}},
		{"Seek sends absolute-percent", func(p *Player) { p.Seek(50) }, []any{"seek", 50.0, "absolute-percent"}},
		{"Skip sends relative seek", func(p *Player) { p.Skip(10) }, []any{"seek", 10.0, "relative"}},
		{"Volume sends set_property", func(p *Player) { p.Volume(80) }, []any{"set_property", "volume", 80.0}},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			p, _, fc := newStreamingPlayer(t)

			tc.call(p)
			syncPlayer(p)

			if len(fc.commands) == 0 {
				t.Fatalf("expected command, got none")
			}
			if !reflect.DeepEqual(fc.commands[0], tc.wantCmd) {
				t.Errorf("expected: %v, got %v", tc.wantCmd, fc.commands[0])
			}
		})
	}
}

func TestCommands_NoOpWhenNotStreaming(t *testing.T) {
	testCases := []struct {
		name string
		call func(p *Player)
	}{
		{"Pause is no-op", func(p *Player) { p.Pause() }},
		{"Seek is no-op", func(p *Player) { p.Seek(50) }},
		{"Skip is no-op", func(p *Player) { p.Skip(10) }},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			p, _, fc := newTestPlayer(t)

			tc.call(p)
			syncPlayer(p)

			if len(fc.commands) > 0 {
				t.Errorf("expected no command, got %v", fc.commands)
			}
		})
	}
}

func TestStop_ForwardsToControllerWhenStreaming(t *testing.T) {
	p, _, fc := newStreamingPlayer(t)

	p.Stop()
	syncPlayer(p)

	if fc.stopCalls != 1 {
		t.Errorf("expected Stop to be forwarded once, got %d", fc.stopCalls)
	}
}

func TestStop_IsNoOpWhenNotStreaming(t *testing.T) {
	p, _, fc := newTestPlayer(t)

	p.Stop()
	syncPlayer(p)

	if fc.stopCalls != 0 {
		t.Errorf("expected Stop to be a no-op, got %d calls", fc.stopCalls)
	}
}

func TestStoppedEvent_EmitsStoppedAndUpdatesSnapshot(t *testing.T) {
	p, ctrlEvents, _ := newStreamingPlayer(t)

	ctrlEvents <- mpv.Event{Kind: mpv.Stopped}

	select {
	case e := <-p.Events:
		if e.Kind != Stopped {
			t.Errorf("expected event kind Stopped, got: %v", e.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out")
	}

	if p.Snapshot().Streaming != false {
		t.Errorf("expected Streaming to be false after Stop()")
	}

}

func TestEventJSON(t *testing.T) {
	cases := []struct {
		event Event
		want  string
	}{
		{Event{Kind: Position, Value: 12.3}, `{"type":"position","value":12.3}`},
		{Event{Kind: Stopped}, `{"type":"stopped"}`},
		{Event{Kind: Paused, Value: true}, `{"type":"paused","value":true}`},
	}

	for _, tc := range cases {
		got, err := json.Marshal(tc.event)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Errorf("got %s, want %s", got, tc.want)
		}
	}
}
