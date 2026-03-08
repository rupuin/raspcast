package ws

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/rupuin/raspcast/server/player"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type Player interface {
	Play(url string) error
	Pause()
	Stop()
	Seek(percent float64)
	Skip(seconds float64)
	Volume(val float64)
	Snapshot() player.State
}

type outbound struct {
	client *Client
	msg    []byte
}

type Hub struct {
	clients    map[*Client]struct{}
	register   chan *Client
	unregister chan *Client
	outbound   chan outbound
	player     Player
	events     <-chan player.Event
}

func NewHub(p Player, events <-chan player.Event) *Hub {
	return &Hub{
		clients:    make(map[*Client]struct{}),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		outbound:   make(chan outbound, 16),
		player:     p,
		events:     events,
	}
}

func (h *Hub) removeClient(client *Client) {
	if _, ok := h.clients[client]; !ok {
		return
	}

	delete(h.clients, client)
	close(client.send)
	client.conn.Close()
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.clients[client] = struct{}{}
		case client := <-h.unregister:
			h.removeClient(client)
		case outbound := <-h.outbound:
			if _, ok := h.clients[outbound.client]; !ok {
				continue
			}

			select {
			case outbound.client.send <- outbound.msg:
			default:
				h.removeClient(outbound.client)
			}
		case event := <-h.events:
			serialized, err := json.Marshal(event)
			if err != nil {
				slog.Error("failed to marshal event", "err", err)
				continue
			}

			for client := range h.clients {
				select {
				case client.send <- serialized:
				default:
					// assume dead or slow client
					h.removeClient(client)
				}
			}
		}
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("error serving websocket", "err", err)
		return
	}

	client := &Client{hub: h, conn: conn, send: make(chan []byte, 256)}
	client.hub.register <- client

	go client.writePump()
	go client.readPump()
}
