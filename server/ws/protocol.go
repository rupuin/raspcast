package ws

import (
	"encoding/json"

	"github.com/rupuin/raspcast/server/player"
)

type ClientMessage struct {
	Type    string  `json:"type"`
	URL     string  `json:"url,omitempty"`
	Percent float64 `json:"percent,omitempty"`
	Seconds float64 `json:"seconds,omitempty"`
	Value   float64 `json:"value,omitempty"`
}

type ServerMessage struct {
	Type  string `json:"type"`
	Value any    `json:"value,omitempty"`
}

type ErrorMessage struct {
	Type  string `json:"type"`
	Error string `json:"error"`
}

func DecodeClientMessage(raw []byte) (ClientMessage, error) {
	var msg ClientMessage
	err := json.Unmarshal(raw, &msg)
	return msg, err
}

func EncodeEvent(e player.Event) ([]byte, error) {
	return json.Marshal(ServerMessage{
		Type:  string(e.Kind),
		Value: e.Value,
	})
}

func EncodeSnapshot(state player.State) ([]byte, error) {
	return json.Marshal(ServerMessage{
		Type:  "snapshot",
		Value: state,
	})
}

func EncodeError(err error) []byte {
	msg, _ := json.Marshal(ErrorMessage{
		Type:  "error",
		Error: err.Error(),
	})
	return msg
}
