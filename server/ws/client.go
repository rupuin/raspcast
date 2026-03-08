package ws

import (
	"encoding/json"
	"log/slog"

	"github.com/gorilla/websocket"
)

type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
}

type wsMsg struct {
	Kind    string  `json:"type"`
	URL     string  `json:"url,omitempty"`
	Percent float64 `json:"percent,omitempty"`
	Seconds float64 `json:"seconds,omitempty"`
	Value   float64 `json:"value,omitempty"`
}

func (c *Client) writePump() {
	for msg := range c.send {
		err := c.conn.WriteMessage(websocket.TextMessage, msg)
		if err != nil {
			slog.Error("error writing message to websocket", "err", err)
			c.conn.Close()
			return
		}
	}

	// send close frame so client knows conn closed intentionally
	c.conn.WriteMessage(websocket.CloseMessage, []byte{})
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				slog.Error("error reading websocket message", "err", err)
			}
			break
		}
		c.handle(msg)
	}
}

func (c *Client) handle(rawMsg []byte) {
	var msg wsMsg
	if err := json.Unmarshal(rawMsg, &msg); err != nil {
		slog.Error("error deserializing websocket message", "err", err)
		c.reply(errMsg(err))
		return
	}

	if msg.Kind == "snapshot" {
		snap, err := json.Marshal(c.hub.player.Snapshot())
		if err != nil {
			c.reply(errMsg(err))
			return
		}
		c.reply(snap)
		return
	}

	if err := c.dispatch(msg); err != nil {
		slog.Error("error calling Player action", "err", err)
		c.reply(errMsg(err))
		return
	}
}

func (c *Client) reply(msg []byte) {
	c.hub.outbound <- outbound{client: c, msg: msg}
}

func (c *Client) dispatch(msg wsMsg) error {
	switch msg.Kind {
	case "play":
		return c.hub.player.Play(msg.URL)
	case "pause":
		c.hub.player.Pause()
	case "volume":
		c.hub.player.Volume(msg.Value)
	case "seek":
		c.hub.player.Seek(msg.Percent)
	case "skip":
		c.hub.player.Skip(msg.Seconds)
	case "stop":
		c.hub.player.Stop()
	default:
		slog.Warn("unknown message type", "type", msg.Kind)
	}
	return nil
}

func errMsg(e error) []byte {
	b, _ := json.Marshal(map[string]string{"type": "error", "error": e.Error()})
	return b
}
