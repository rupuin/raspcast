package ipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
)

type Socket struct {
	conn     net.Conn
	Messages chan map[string]any // mpv sends NDJSON messages
	Done     chan struct{}
}

func NewSocket(path string) (*Socket, error) {
	conn, err := net.Dial("unix", path)

	if err != nil {
		return nil, err
	}

	s := &Socket{
		conn:     conn,
		Messages: make(chan map[string]any, 16),
		Done:     make(chan struct{}),
	}
	go s.readLoop()

	return s, nil
}

func (s *Socket) Send(payload any) error {
	if s.conn == nil {
		return fmt.Errorf("socket not connected")
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s.conn, "%s\n", b)
	return err

}

func (s *Socket) Disconnect() {
	if s.conn != nil {
		s.conn.Close()
	}
}

func (s *Socket) readLoop() {
	defer close(s.Done)

	scanner := bufio.NewScanner(s.conn)
	for scanner.Scan() {
		var msg map[string]any
		line := scanner.Text()
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			slog.Error("error reading JSON", "err", err)
			continue
		}

		s.Messages <- msg
	}
}
