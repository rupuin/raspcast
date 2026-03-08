package mpv

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"
)

const (
	Ready       Kind   = "ready"
	Stopped     Kind   = "stopped"
	Property    Kind   = "property"
	SOCKET_PATH string = "/tmp/mpv-socket"
)

type Process interface {
	Kill() error
	Wait() (*os.ProcessState, error)
}

type Launcher interface {
	Launch(url, socketPath string) (Process, error)
}

type Kind string

type Event struct {
	Kind  Kind
	Name  string
	Value any
}

type actionKind string

const (
	actionStart actionKind = "start"
	actionSend  actionKind = "send"
	actionStop  actionKind = "stop"
)

type action struct {
	kind    actionKind
	url     string
	command []any
	reply   chan error
}

type Controller struct {
	Events             <-chan Event
	events             chan Event
	actions            chan action
	launcher           Launcher
	runtime            *runtime
	observedProperties []string
	socketPath         string
	cancelWorker       context.CancelFunc
}

func NewController(launcher Launcher, socketPath string) *Controller {
	events := make(chan Event, 16)
	c := &Controller{
		Events:   events,
		events:   events,
		actions:  make(chan action, 16),
		launcher: launcher,
		observedProperties: []string{
			"media-title",
			"time-pos",
			"duration",
			"pause",
			"volume",
			"track-list",
			"sub-visibility"},
		socketPath: socketPath,
	}
	go c.run()
	return c
}

type workerState struct {
	out  <-chan Event
	done <-chan struct{}
}

func (c *Controller) run() {
	var worker workerState

	for {
		select {
		case action := <-c.actions:
			c.handleAction(action, &worker)
		case event := <-worker.out:
			c.handleWorkerEvent(event)
		case <-worker.done:
			c.handleWorkerDone(&worker)
		}
	}

}

func (c *Controller) Start(url string) error {
	reply := make(chan error, 1)
	c.actions <- action{kind: actionStart, url: url, reply: reply}
	return <-reply
}

func (c *Controller) Send(cmd []any) {
	c.actions <- action{kind: actionSend, command: cmd}
}

func (c *Controller) Stop() {
	c.actions <- action{kind: actionStop}
}

func (c *Controller) handleStart(a action, w *workerState) {
	if a.url == "" {
		a.reply <- fmt.Errorf("no media url provided")
		return
	}

	if c.runtime != nil && c.runtime.hasSocket() {
		a.reply <- c.runtime.command([]any{"loadfile", a.url, "replace"})
		return
	}

	if c.runtime == nil {
		process, err := c.launcher.Launch(a.url, c.socketPath)
		if err != nil {
			a.reply <- err
			return
		}
		c.runtime = newRuntime(process)
	}

	if w.done == nil {
		c.startWorker(w)
	}

	a.reply <- nil
}

func (c *Controller) startWorker(w *workerState) {
	out := make(chan Event, 16)
	done := make(chan struct{})

	ctx, cancel := context.WithCancel(context.Background())
	c.cancelWorker = cancel

	w.out = out
	w.done = done

	rt := c.runtime
	go c.runWorker(ctx, rt, out, done)
}

func (c *Controller) runWorker(
	ctx context.Context,
	rt *runtime,
	out chan<- Event,
	done chan<- struct{},
) {
	defer close(done)
	sockCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	if err := rt.connect(sockCtx, c.socketPath); err != nil {
		slog.Error("error waiting for socket open", "err", err)
		return
	}

	if err := rt.observeProperties(c.observedProperties); err != nil {
		slog.Error("error subscribing to properties", "err", err)
		return
	}

	for {
		select {
		case msg := <-rt.messages():
			event, ok := parseEvent(msg)
			if !ok {
				continue
			}
			select {
			case out <- event:
			case <-ctx.Done():
				return
			}
		case <-rt.done():
			return
		case <-ctx.Done():
			return
		}
	}
}

func (c *Controller) handleWorkerEvent(e Event) {
	c.events <- e
}

func (c *Controller) handleWorkerDone(worker *workerState) {
	unexpected := c.cancelWorker != nil

	worker.out = nil
	worker.done = nil
	c.cancelWorker = nil

	if !unexpected {
		return
	}

	if c.runtime != nil {
		c.runtime = nil
	}
	c.events <- Event{Kind: Stopped}
}

func (c *Controller) handleAction(action action, worker *workerState) {
	switch action.kind {
	case actionStart:
		c.handleStart(action, worker)
	case actionSend:
		c.handleSend(action.command)
	case actionStop:
		c.handleStop(worker)
	}
}

func (c *Controller) handleSend(command []any) {
	if c.runtime == nil {
		slog.Warn("runtime not found; nothing to send")
		return
	}
	if err := c.runtime.command(command); err != nil {
		slog.Warn("runtime command failed", "err", err)
	}
}

func (c *Controller) handleStop(worker *workerState) {
	stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if c.cancelWorker != nil {
		c.cancelWorker()
	}

	if worker.done != nil {
		<-worker.done
	}

	worker.out = nil
	worker.done = nil
	c.cancelWorker = nil

	if c.runtime != nil {
		state, err := c.runtime.stop(stopCtx)
		if err != nil {
			slog.Error("error stopping runtime", "state", state, "err", err)
		}
		c.runtime = nil
	}

	c.events <- Event{Kind: Stopped}
}

func parseEvent(msg map[string]any) (Event, bool) {
	event, ok := msg["event"].(string)
	if !ok {
		return Event{}, false
	}
	if event == "file-loaded" {
		return Event{Kind: Ready}, true
	}
	if event != "property-change" {
		return Event{}, false
	}
	name, ok := msg["name"].(string)
	if !ok {
		return Event{}, false
	}

	return Event{Kind: Property, Name: name, Value: msg["data"]}, true
}
