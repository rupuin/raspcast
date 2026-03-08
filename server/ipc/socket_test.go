package ipc

import (
	"encoding/json"
	"fmt"
	"net"
	"testing"
	"time"
)

func startFakeServer(t *testing.T) (path string, listener net.Listener) {
	path = fmt.Sprintf("/tmp/test-mpv-%d.sock", time.Now().UnixNano())
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	return path, l
}

func TestNewSocket_Success(t *testing.T) {
	path, listener := startFakeServer(t)
	defer listener.Close()
	go listener.Accept()

	socket, err := NewSocket(path)

	if err != nil {
		t.Fatalf("expected no err, got %v", err)
	}

	if socket == nil {
		t.Errorf("expected socket, got %v", socket)
	}

	defer socket.Disconnect()
}

func TestNewSocket_Failure(t *testing.T) {
	_, err := NewSocket("/tmp/doesnotexist.sock")

	if err == nil {
		t.Errorf("expected err, got nil")
	}
}

func TestSend_WritesPayload(t *testing.T) {
	path, listener := startFakeServer(t)
	defer listener.Close()

	var serverConn net.Conn
	ready := make(chan struct{})

	go func() {
		serverConn, _ = listener.Accept()
		close(ready)
	}()

	payload := map[string]any{"command": []any{"observe_property", 1, "time-pos"}}

	socket, _ := NewSocket(path)
	<-ready

	err := socket.Send(payload)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	buf := make([]byte, 1024)
	n, _ := serverConn.Read(buf)
	got := string(buf[:n])

	bytes, _ := json.Marshal(payload)
	expected := string(bytes) + "\n"

	if got != expected {
		t.Errorf("expected %q, got: %q", expected, got)
	}
}

func TestReadLoop(t *testing.T) {
	testCases := []struct {
		name     string
		lines    []string
		expected string
	}{
		{
			name:     "valid JSON delivered",
			lines:    []string{`{"event":"pause"}` + "\n"},
			expected: "pause",
		},
		{
			name:     "invalid JSON skipped, valid delivered",
			lines:    []string{"bad:json\n", `{"event":"skip"}` + "\n"},
			expected: "skip",
		},
		{
			name:     "empty line skipped, valid delivered",
			lines:    []string{"\n", `{"event":"volume"}` + "\n"},
			expected: "volume",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			path, listener := startFakeServer(t)
			defer listener.Close()

			var serverConn net.Conn
			ready := make(chan struct{})

			go func() {
				serverConn, _ = listener.Accept()
				close(ready)
			}()

			socket, _ := NewSocket(path)
			<-ready

			for _, line := range tc.lines {
				serverConn.Write([]byte(line))
			}

			select {
			case msg := <-socket.Messages:
				if msg["event"] != tc.expected {
					t.Errorf("expected: %v, got: %v", tc.expected, msg["event"])
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for message")
			}

		})
	}

}
