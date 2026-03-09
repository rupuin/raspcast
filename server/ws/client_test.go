package ws

import (
	"encoding/json"
	"testing"

	"github.com/rupuin/raspcast/server/player"
)

type mockPlayer struct {
	action   string
	url      string
	percent  float64
	seconds  float64
	value    float64
	snapshot player.State
	playErr  error
}

func (m *mockPlayer) Play(url string) error  { m.action = "play"; m.url = url; return m.playErr }
func (m *mockPlayer) Pause()                 { m.action = "pause" }
func (m *mockPlayer) Stop()                  { m.action = "stop" }
func (m *mockPlayer) Seek(percent float64)   { m.action = "seek"; m.percent = percent }
func (m *mockPlayer) Skip(seconds float64)   { m.action = "skip"; m.seconds = seconds }
func (m *mockPlayer) Volume(val float64)     { m.action = "volume"; m.value = val }
func (m *mockPlayer) Snapshot() player.State { return m.snapshot }

func newTestClient(p Player) *Client {
	return &Client{
		hub:  &Hub{player: p, outbound: make(chan outbound, 4)},
		send: make(chan []byte, 4),
	}
}

func TestDispatch(t *testing.T) {
	cases := []struct {
		msg        ClientMessage
		wantAction string
		wantURL    string
		wantValue  float64
	}{
		{ClientMessage{Type: "play", URL: "https://example.com"}, "play", "https://example.com", 0},
		{ClientMessage{Type: "pause"}, "pause", "", 0},
		{ClientMessage{Type: "stop"}, "stop", "", 0},
		{ClientMessage{Type: "seek", Percent: 42.5}, "seek", "", 42.5},
		{ClientMessage{Type: "skip", Seconds: -10}, "skip", "", -10},
		{ClientMessage{Type: "volume", Value: 80}, "volume", "", 80},
	}

	for _, tc := range cases {
		m := &mockPlayer{}
		c := newTestClient(m)

		if err := c.dispatch(tc.msg); err != nil {
			t.Errorf("dispatch(%q) unexpected error: %v", tc.msg.Type, err)
		}
		if m.action != tc.wantAction {
			t.Errorf("dispatch(%q): got action %q, want %q", tc.msg.Type, m.action, tc.wantAction)
		}
		if tc.wantURL != "" && m.url != tc.wantURL {
			t.Errorf("dispatch(%q): got url %q, want %q", tc.msg.Type, m.url, tc.wantURL)
		}
		if tc.wantValue != 0 {
			var got float64
			switch tc.msg.Type {
			case "seek":
				got = m.percent
			case "skip":
				got = m.seconds
			case "volume":
				got = m.value
			}
			if got != tc.wantValue {
				t.Errorf("dispatch(%q): got value %v, want %v", tc.msg.Type, got, tc.wantValue)
			}
		}
	}
}

func TestHandleSnapshot_QueuesOutboundReply(t *testing.T) {
	m := &mockPlayer{snapshot: player.State{Streaming: true, Title: "demo"}}
	c := newTestClient(m)

	c.handle([]byte(`{"type":"snapshot"}`))

	select {
	case out := <-c.hub.outbound:
		if out.client != c {
			t.Fatalf("expected outbound reply for current client")
		}

		var got struct {
			Type  string       `json:"type"`
			Value player.State `json:"value"`
		}
		if err := json.Unmarshal(out.msg, &got); err != nil {
			t.Fatalf("failed to decode snapshot reply: %v", err)
		}
		if got.Type != "snapshot" {
			t.Fatalf("expected snapshot reply, got %+v", got)
		}
		if got.Value != m.snapshot {
			t.Fatalf("expected snapshot %+v, got %+v", m.snapshot, got.Value)
		}
	default:
		t.Fatal("expected snapshot reply to be queued")
	}

	select {
	case <-c.send:
		t.Fatal("expected client send queue to stay hub-owned")
	default:
	}
}

func TestHandleInvalidJSON_QueuesOutboundError(t *testing.T) {
	c := newTestClient(&mockPlayer{})

	c.handle([]byte("{"))

	select {
	case out := <-c.hub.outbound:
		if out.client != c {
			t.Fatalf("expected outbound error for current client")
		}

		var got map[string]string
		if err := json.Unmarshal(out.msg, &got); err != nil {
			t.Fatalf("failed to decode error reply: %v", err)
		}
		if got["type"] != "error" {
			t.Fatalf("expected error reply, got %+v", got)
		}
	default:
		t.Fatal("expected error reply to be queued")
	}
}
