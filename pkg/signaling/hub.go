package signaling

import (
	"log"
	"net/http"
	"sync"

	"github.com/FelippeRibeiro/go-live/pkg/room"
)

// Hub broadcasts the public room list to homepage viewers in real time.
type Hub struct {
	Manager *room.Manager

	mu      sync.Mutex
	clients map[*Client]struct{}
}

// NewHub creates a hub and wires manager change notifications.
func NewHub(mgr *room.Manager) *Hub {
	h := &Hub{
		Manager: mgr,
		clients: make(map[*Client]struct{}),
	}
	mgr.SetOnChange(h.Broadcast)
	return h
}

// ServeWS upgrades a connection and keeps it subscribed to hub updates.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("hub websocket upgrade failed: %v", err)
		return
	}

	client := NewClient(conn)
	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()

	go client.WritePump()
	h.sendSnapshot(client)

	// Keep reading until disconnect (ignore inbound payloads).
	client.ReadPump(func([]byte) {})

	h.mu.Lock()
	delete(h.clients, client)
	h.mu.Unlock()
	log.Printf("hub client disconnected")
}

func (h *Hub) sendSnapshot(c *Client) {
	rooms := h.Manager.ListPublic()
	_ = c.SendJSON(map[string]any{
		"action": "rooms",
		"rooms":  rooms,
	})
}

// Broadcast pushes the current public room list to every hub client.
func (h *Hub) Broadcast() {
	rooms := h.Manager.ListPublic()
	payload := map[string]any{
		"action": "rooms",
		"rooms":  rooms,
	}

	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		if err := c.SendJSON(payload); err != nil {
			log.Printf("hub broadcast send failed: %v", err)
		}
	}
}
