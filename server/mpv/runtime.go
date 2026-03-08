package mpv

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/rupuin/raspcast/server/ipc"
)

type runtime struct {
	process Process
	socket  *ipc.Socket
}

func newRuntime(process Process) *runtime {
	return &runtime{process: process}
}

func (r *runtime) connect(ctx context.Context, socketPath string) error {
	for {
		socket, err := ipc.NewSocket(socketPath)
		if err == nil {
			r.socket = socket
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("connecting to socket timed out")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (r *runtime) messages() <-chan map[string]any {
	if r.socket == nil {
		return nil
	}
	return r.socket.Messages
}

func (r *runtime) done() <-chan struct{} {
	if r.socket == nil {
		return nil
	}
	return r.socket.Done
}

func (r *runtime) observeProperties(props []string) error {
	if !r.hasSocket() {
		return fmt.Errorf("not attached to a socket")
	}

	for i, prop := range props {
		mpvCmd := []any{"observe_property", i + 1, prop}
		if err := r.socket.Send(map[string]any{"command": mpvCmd}); err != nil {
			return err
		}
	}
	return nil
}

func (r *runtime) hasSocket() bool {
	return r != nil && r.socket != nil
}

func (r *runtime) command(cmd []any) error {
	if !r.hasSocket() {
		return fmt.Errorf("not attached to a socket")
	}
	return r.socket.Send(map[string]any{"command": cmd})
}

func (r *runtime) stop(ctx context.Context) (*os.ProcessState, error) {
	if r == nil {
		return nil, nil
	}

	var stopErr error
	if r.socket != nil {
		if err := r.command([]any{"quit"}); err != nil {
			stopErr = errors.Join(stopErr, err)
		}
		r.disconnect()
	}

	if r.process == nil {
		return nil, stopErr
	}

	waitDone := make(chan struct {
		state *os.ProcessState
		err   error
	}, 1)

	go func() {
		state, err := r.wait()
		waitDone <- struct {
			state *os.ProcessState
			err   error
		}{state: state, err: err}
	}()

	select {
	case result := <-waitDone:
		return result.state, errors.Join(stopErr, result.err)
	case <-ctx.Done():
		stopErr = errors.Join(stopErr, ctx.Err())

		if err := r.kill(); err != nil {
			return nil, errors.Join(stopErr, err)
		}
		result := <-waitDone
		return result.state, errors.Join(stopErr, result.err)
	}
}

func (r *runtime) kill() error {
	if r == nil || r.process == nil {
		return nil
	}
	return r.process.Kill()
}

func (r *runtime) wait() (*os.ProcessState, error) {
	if r == nil || r.process == nil {
		return nil, nil
	}
	state, err := r.process.Wait()
	r.process = nil
	return state, err
}

func (r *runtime) disconnect() {
	if r == nil || r.socket == nil {
		return
	}
	r.socket.Disconnect()
	r.socket = nil
}
