package signaling

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// FileHub sinaliza broadcast P2P de arquivo de vídeo (mesh 1→N).
// A mídia não passa por aqui — só SDP/ICE.
type FileHub struct {
	mu           sync.Mutex
	broadcaster  *fileClient
	watchers     map[string]*fileClient
}

type fileClient struct {
	id   string
	conn *websocket.Conn
	send chan []byte
}

type fileMsg struct {
	Action    string          `json:"action"`
	ID        string          `json:"id,omitempty"`
	To        string          `json:"to,omitempty"`
	From      string          `json:"from,omitempty"`
	SDP       json.RawMessage `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

// NewFileHub creates an empty file-broadcast signaling hub.
func NewFileHub() *FileHub {
	return &FileHub{watchers: make(map[string]*fileClient)}
}

// ServeWS upgrades and runs the file-broadcast signaling loop.
func (h *FileHub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("file-hub upgrade: %v", err)
		return
	}

	id := newPeerID()
	c := &fileClient{id: id, conn: conn, send: make(chan []byte, 32)}
	go c.writePump()

	defer h.onDisconnect(c)
	c.readPump(func(data []byte) {
		var msg fileMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			return
		}
		switch msg.Action {
		case "broadcaster":
			h.setBroadcaster(c)
		case "watcher":
			h.addWatcher(c)
		case "offer", "answer", "candidate":
			h.relay(c, msg)
		}
	})
}

func (h *FileHub) setBroadcaster(c *fileClient) {
	h.mu.Lock()
	old := h.broadcaster
	delete(h.watchers, c.id)
	h.broadcaster = c
	watchers := make([]*fileClient, 0, len(h.watchers))
	for _, w := range h.watchers {
		watchers = append(watchers, w)
	}
	h.mu.Unlock()

	if old != nil && old.id != c.id {
		old.sendJSON(fileMsg{Action: "forceStop"})
	}
	for _, w := range watchers {
		w.sendJSON(fileMsg{Action: "broadcaster"})
	}
	log.Printf("file-hub broadcaster=%s watchers=%d", c.id, len(watchers))
}

func (h *FileHub) addWatcher(c *fileClient) {
	h.mu.Lock()
	if h.broadcaster != nil && h.broadcaster.id == c.id {
		h.mu.Unlock()
		return
	}
	h.watchers[c.id] = c
	bc := h.broadcaster
	h.mu.Unlock()

	if bc != nil {
		bc.sendJSON(fileMsg{Action: "watcher", ID: c.id})
	}
}

func (h *FileHub) relay(from *fileClient, msg fileMsg) {
	if msg.To == "" {
		return
	}
	h.mu.Lock()
	var target *fileClient
	if h.broadcaster != nil && h.broadcaster.id == msg.To {
		target = h.broadcaster
	} else if w, ok := h.watchers[msg.To]; ok {
		target = w
	}
	h.mu.Unlock()
	if target == nil {
		return
	}
	out := fileMsg{
		Action:    msg.Action,
		From:      from.id,
		SDP:       msg.SDP,
		Candidate: msg.Candidate,
	}
	target.sendJSON(out)
}

func (h *FileHub) onDisconnect(c *fileClient) {
	h.mu.Lock()
	wasBroadcaster := h.broadcaster != nil && h.broadcaster.id == c.id
	if wasBroadcaster {
		h.broadcaster = nil
	}
	delete(h.watchers, c.id)
	bc := h.broadcaster
	watchers := make([]*fileClient, 0, len(h.watchers))
	for _, w := range h.watchers {
		watchers = append(watchers, w)
	}
	h.mu.Unlock()

	close(c.send)
	_ = c.conn.Close()

	if wasBroadcaster {
		for _, w := range watchers {
			w.sendJSON(fileMsg{Action: "broadcasterLeft"})
		}
		log.Printf("file-hub broadcaster left")
		return
	}
	if bc != nil {
		bc.sendJSON(fileMsg{Action: "disconnectPeer", ID: c.id})
	}
}

func (c *fileClient) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	default:
	}
}

func (c *fileClient) writePump() {
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

func (c *fileClient) readPump(handler func([]byte)) {
	defer func() { _ = c.conn.Close() }()
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		handler(data)
	}
}
