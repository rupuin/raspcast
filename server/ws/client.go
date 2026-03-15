package ws

import (
	"log/slog"

	"github.com/gorilla/websocket"
)

type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
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
			if websocket.IsUnexpectedCloseError(
				err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
			) {
				slog.Error("error reading websocket message", "err", err)
			}
			break
		}
		c.handle(msg)
	}
}

func (c *Client) handle(rawMsg []byte) {
	msg, err := DecodeClientMessage(rawMsg)
	if err != nil {
		slog.Error("error deserializing websocket message", "err", err)
		c.reply(EncodeError(err))
		return
	}

	addr := "<nil>"
	if c.conn != nil {
		addr = c.conn.RemoteAddr().String()
	}

	slog.Info("ws command", "type", msg.Type, "addr", addr)

	if msg.Type == "snapshot" {
		snap, err := EncodeSnapshot(c.hub.player.Snapshot())
		if err != nil {
			c.reply(EncodeError(err))
			return
		}
		c.reply(snap)
		return
	}

	if err := c.dispatch(msg); err != nil {
		slog.Error("error calling Player action", "err", err)
		c.reply(EncodeError(err))
		return
	}
}

func (c *Client) reply(msg []byte) {
	c.hub.outbound <- outbound{client: c, msg: msg}
}

func (c *Client) dispatch(msg ClientMessage) error {
	switch msg.Type {
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
		slog.Warn("unknown message type", "type", msg.Type)
	}
	return nil
}
