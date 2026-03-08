package mpv

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"reflect"
	"testing"
	"time"
)

type fakeProcess struct{}

func (f *fakeProcess) Kill() error                     { return nil }
func (f *fakeProcess) Wait() (*os.ProcessState, error) { return nil, nil }

type fakeLauncher struct {
	socketPath  string
	listener    net.Listener
	conn        chan net.Conn
	launchCalls int
}

func newFakeLauncher(t *testing.T, socketPath string) *fakeLauncher {
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		l.Close()
		os.Remove(socketPath)
	})

	fl := fakeLauncher{
		socketPath: socketPath,
		listener:   l,
		conn:       make(chan net.Conn, 1),
	}
	go func() {
		conn, _ := l.Accept()
		fl.conn <- conn
	}()

	return &fl
}

func (fl *fakeLauncher) Launch(url, socketPath string) (Process, error) {
	fl.launchCalls++
	return &fakeProcess{}, nil
}

func newTestController(t *testing.T) (*Controller, *fakeLauncher, net.Conn) {
	socketPath := fmt.Sprintf("/tmp/test-mpv-%d.sock", time.Now().UnixNano())
	launcher := newFakeLauncher(t, socketPath)

	controller := NewController(launcher, socketPath)
	if err := controller.Start("http://video"); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn := <-launcher.conn
	return controller, launcher, conn
}

func startRuntimeReadyController(t *testing.T) (*Controller, net.Conn) {
	controller, _, conn := newTestController(t)

	conn.Write([]byte(`{"event":"file-loaded"}` + "\n"))

	select {
	case msg := <-controller.Events:
		if msg.Kind != Ready {
			t.Fatalf("expected Ready, got: %v", msg.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Ready")
	}

	return controller, conn
}

func TestStart_EmitsReadyOnlyAfterFileLoaded(t *testing.T) {
	ctrl, _, conn := newTestController(t)

	select {
	case msg := <-ctrl.Events:
		t.Fatalf("expected no event before file-loaded, got: %v", msg)
	case <-time.After(100 * time.Millisecond):
	}

	conn.Write([]byte(`{"event":"file-loaded"}` + "\n"))

	select {
	case msg := <-ctrl.Events:
		if msg.Kind != Ready {
			t.Errorf("expected Ready, got: %v", msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for message")
	}
}

func TestStart_LoadsFileWhenMpvProcessRunning(t *testing.T) {
	ctrl, launcher, conn := newTestController(t)
	defer conn.Close()

	dec := json.NewDecoder(conn)

	for range 7 {
		var msg map[string]any
		if err := dec.Decode(&msg); err != nil {
			t.Fatalf("decode subscribe command: %v", err)
		}
	}

	if err := ctrl.Start("http://new-video"); err != nil {
		t.Fatalf("second Start failed: %v", err)
	}

	var msg map[string]any
	if err := dec.Decode(&msg); err != nil {
		t.Fatalf("decode loadfile command: %v", err)
	}

	command, ok := msg["command"].([]any)
	if !ok {
		t.Fatalf("expected command array, got %#v", msg["command"])
	}

	want := []any{"loadfile", "http://new-video", "replace"}
	if !reflect.DeepEqual(command, want) {
		t.Fatalf("expected %v, got %v", want, command)
	}

	if launcher.launchCalls != 1 {
		t.Fatalf("expected 1 launch call, got %d", launcher.launchCalls)
	}

}

func TestConsume_PropertyEvents(t *testing.T) {
	testCases := []struct {
		name     string
		lines    []string
		wantName string
		wantData any
	}{
		{
			name:     "pause event",
			lines:    []string{`{"event":"property-change","name":"pause","data":true}` + "\n"},
			wantName: "pause",
			wantData: true,
		},
		{
			name: "non-property event filtered, volume delivered",
			lines: []string{
				`{"event":"start-file"}` + "\n",
				`{"event":"property-change","name":"volume","data":85.0}` + "\n",
			},
			wantName: "volume",
			wantData: 85.0,
		},
		{
			name: "invalid json filtered, time-pos delivered",
			lines: []string{
				"bad json\n",
				`{"event":"property-change","name":"time-pos","data":42.3}` + "\n",
			},
			wantName: "time-pos",
			wantData: 42.3,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			controller, conn := startRuntimeReadyController(t)

			for _, line := range tc.lines {
				conn.Write([]byte(line))
			}

			select {
			case msg := <-controller.Events:
				if !reflect.DeepEqual(msg.Name, tc.wantName) {
					t.Errorf("expected Event.Name %v, got %v", tc.wantName, msg.Name)
				}
				if !reflect.DeepEqual(msg.Value, tc.wantData) {
					t.Errorf("expected Event.Value %v, got %v", tc.wantData, msg.Value)
				}
			case <-time.After(time.Second):
				t.Fatalf("timed out waiting for message")
			}
		})
	}

}

func TestConsume_EmitsStopped_WhenSocketCloses(t *testing.T) {
	controller, conn := startRuntimeReadyController(t)

	conn.Close()
	select {
	case msg := <-controller.Events:
		if msg.Kind != Stopped {
			t.Errorf("expected Stopped, got: %v", msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for message")
	}
}

func TestConsume_EmitsStoppedOnlyOnce_WhenSocketCloses(t *testing.T) {
	controller, conn := startRuntimeReadyController(t)

	conn.Close()

	select {
	case msg := <-controller.Events:
		if msg.Kind != Stopped {
			t.Fatalf("expected first event to be Stopped, got: %v", msg.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first Stopped")
	}

	select {
	case msg := <-controller.Events:
		t.Fatalf("expected no second event after socket close, got: %#v", msg)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestStop_EmitsStoppedOnlyOnce(t *testing.T) {
	controller, _ := startRuntimeReadyController(t)

	controller.Stop()

	select {
	case msg := <-controller.Events:
		if msg.Kind != Stopped {
			t.Fatalf("expected first event to be Stopped, got: %v", msg.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first Stopped")
	}

	select {
	case msg := <-controller.Events:
		t.Fatalf("expected no event after Stop, got: %#v", msg)
	case <-time.After(100 * time.Millisecond):
	}
}
