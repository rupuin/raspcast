package player

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/rupuin/raspcast/server/mpv"
)

type MpvController interface {
	Start(url string) error
	Stop()
	Send(cmd []any)
}

type Kind string

const (
	Streaming Kind = "active"
	Stopped   Kind = "stopped"
	Position  Kind = "position"
	Duration  Kind = "duration"
	Paused    Kind = "paused"
	Volume    Kind = "volume"
	Title     Kind = "title"
	Subtitles Kind = "subtitles"
)

type ActionKind string

const (
	ActionPlay     ActionKind = "play"
	ActionStop     ActionKind = "stop"
	ActionPause    ActionKind = "pause"
	ActionSeek     ActionKind = "seek"
	ActionSkip     ActionKind = "skip"
	ActionVolume   ActionKind = "volume"
	ActionSnapshot ActionKind = "snapshot"
)

type Event struct {
	Kind  Kind `json:"type"`
	Value any  `json:"value,omitempty"`
}

type State struct {
	Streaming bool    `json:"streaming"`
	URL       string  `json:"url"`
	Position  float64 `json:"position"`
	Duration  float64 `json:"duration"`
	Paused    bool    `json:"paused"`
	Volume    float64 `json:"volume"`
	Title     string  `json:"title"`
}

type action struct {
	kind  ActionKind
	url   string
	value float64
	reply chan error
	state chan State
}

type Player struct {
	Events     chan Event
	ctrl       MpvController
	ctrlEvents <-chan mpv.Event
	actions    chan action
	done       chan struct{}

	state            State
	pendingURL       string
	desiredVolume    float64
	hasDesiredVolume bool
	shutdownOnce     sync.Once
}

func New(ctrl MpvController, ctrlEvents <-chan mpv.Event) *Player {
	p := &Player{
		Events:     make(chan Event, 16),
		actions:    make(chan action, 16),
		done:       make(chan struct{}),
		ctrl:       ctrl,
		ctrlEvents: ctrlEvents,
	}
	go p.run()
	return p
}

func (p *Player) run() {
	for {
		select {
		case event, ok := <-p.ctrlEvents:
			if !ok {
				return
			}
			p.handleEvent(event)
		case action := <-p.actions:
			p.handleAction(action)
		case <-p.done:
			return
		}
	}
}

func (p *Player) Play(url string) error {
	reply := make(chan error, 1)
	if !p.enqueue(action{kind: ActionPlay, url: url, reply: reply}) {
		return fmt.Errorf("player shut down")
	}
	return <-reply
}

func (p *Player) Stop() {
	p.enqueue(action{kind: ActionStop})
}

func (p *Player) Pause() {
	p.enqueue(action{kind: ActionPause})
}

func (p *Player) Volume(val float64) {
	p.enqueue(action{kind: ActionVolume, value: val})
}

func (p *Player) Seek(percent float64) {
	p.enqueue(action{kind: ActionSeek, value: percent})
}

func (p *Player) Skip(seconds float64) {
	p.enqueue(action{kind: ActionSkip, value: seconds})
}

func (p *Player) Snapshot() State {
	state := make(chan State, 1)
	if !p.enqueue(action{kind: ActionSnapshot, state: state}) {
		return State{}
	}
	return <-state
}

func (p *Player) Shutdown() {
	p.shutdownOnce.Do(func() {
		close(p.done)
	})
}

func (p *Player) enqueue(action action) bool {
	select {
	case p.actions <- action:
		return true
	case <-p.done:
		return false
	}
}

func (p *Player) handleAction(action action) {
	switch action.kind {
	case ActionPlay:
		p.play(action)
	case ActionStop:
		if p.state.Streaming {
			p.ctrl.Stop()
		}
	case ActionPause:
		if p.state.Streaming {
			p.ctrl.Send([]any{"cycle", "pause"})
		}
	case ActionVolume:
		p.desiredVolume = action.value
		p.hasDesiredVolume = true
		if p.state.Streaming {
			p.ctrl.Send([]any{"set_property", "volume", action.value})
		}
	case ActionSeek:
		if p.state.Streaming {
			p.ctrl.Send([]any{"seek", action.value, "absolute-percent"})
		}
	case ActionSkip:
		if p.state.Streaming {
			p.ctrl.Send([]any{"seek", action.value, "relative"})
		}
	case ActionSnapshot:
		action.state <- p.state
	}
}

func (p *Player) play(action action) {
	if action.url == "" {
		action.reply <- fmt.Errorf("no media url provided")
		return
	}
	p.pendingURL = action.url
	action.reply <- p.ctrl.Start(action.url)
}

func (p *Player) handleEvent(e mpv.Event) {
	switch e.Kind {
	case mpv.Ready:
		p.state.Streaming = true
		p.state.URL = p.pendingURL
		p.Events <- Event{Kind: Streaming, Value: p.pendingURL}
		if p.hasDesiredVolume {
			p.ctrl.Send([]any{"set_property", "volume", p.desiredVolume})
		}
	case mpv.Stopped:
		p.state = State{}
		p.Events <- Event{Kind: Stopped}
	case mpv.Property:
		p.handleProperty(e.Name, e.Value)
	}
}

func cast[T any](val any, name string) (T, bool) {
	v, ok := val.(T)
	if !ok {
		slog.Warn("unexpected property type", "name", name, "val", val)
	}
	return v, ok
}

func (p *Player) handleProperty(name string, val any) {
	switch name {
	case "media-title":
		if v, ok := cast[string](val, name); ok {
			if val == nil {
				return
			}
			p.state.Title = v
			p.Events <- Event{Kind: Title, Value: v}
		}
	case "time-pos":
		if val == nil {
			return
		}
		if v, ok := cast[float64](val, name); ok {
			p.state.Position = v
			p.Events <- Event{Kind: Position, Value: v}
		}
	case "duration":
		if val == nil {
			return
		}
		if v, ok := cast[float64](val, name); ok {
			p.state.Duration = v
			p.Events <- Event{Kind: Duration, Value: v}
		}
	case "volume":
		if val == nil {
			return
		}
		if v, ok := cast[float64](val, name); ok {
			p.state.Volume = v
			p.Events <- Event{Kind: Volume, Value: v}
		}
	case "pause":
		if val == nil {
			return
		}
		if v, ok := cast[bool](val, name); ok {
			p.state.Paused = v
			p.Events <- Event{Kind: Paused, Value: v}
		}
	case "track-list":
	case "sub-visibility":
	}
}
