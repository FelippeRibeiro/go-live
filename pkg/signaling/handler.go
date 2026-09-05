package signaling

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"

	"github.com/FelippeRibeiro/go-live/pkg/room"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Message is the generic WebSocket signaling envelope.
type Message struct {
	Action    string          `json:"action"`
	RoomID    string          `json:"room_id,omitempty"`
	Password  string          `json:"password,omitempty"`
	Role      string          `json:"role,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Type      string          `json:"type,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Message   string          `json:"message,omitempty"`
}

// Handler wires WebSocket upgrades to the room manager.
type Handler struct {
	Manager *room.Manager
}

// ServeWS upgrades the connection and runs the signaling loop.
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	client := NewClient(conn)
	go client.WritePump()

	peerID := newPeerID()
	var (
		joinedRoom *room.Room
		role       room.PeerRole
	)

	cleanup := func() {
		if joinedRoom == nil {
			return
		}
		roomID := joinedRoom.ID
		switch role {
		case room.RolePublisher:
			joinedRoom.RemovePublisher(peerID)
		case room.RoleSubscriber:
			joinedRoom.RemoveSubscriber(peerID)
		}
		h.Manager.RemoveIfEmpty(roomID)
		joinedRoom = nil
	}

	client.ReadPump(func(data []byte) {
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("invalid signaling json: %v", err)
			_ = client.SendJSON(map[string]any{"action": "error", "message": "invalid json"})
			return
		}

		switch msg.Action {
		case "join":
			if joinedRoom != nil {
				_ = client.SendJSON(map[string]any{"action": "error", "message": "already joined"})
				return
			}
			if !room.ValidRoomID(msg.RoomID) {
				log.Printf("join rejected: invalid room_id=%q", msg.RoomID)
				_ = client.SendJSON(map[string]any{"action": "error", "message": "invalid room_id"})
				return
			}

			rm, err := h.Manager.Get(msg.RoomID)
			if err != nil {
				log.Printf("join rejected: room not found id=%s", msg.RoomID)
				_ = client.SendJSON(map[string]any{"action": "error", "message": "room not found"})
				return
			}

			if err := rm.CheckPassword(msg.Password); err != nil {
				log.Printf("join rejected: bad password room=%s", msg.RoomID)
				_ = client.SendJSON(map[string]any{"action": "error", "message": "wrong password"})
				return
			}

			switch msg.Role {
			case string(room.RolePublisher):
				if _, err := rm.AddPublisher(peerID, client); err != nil {
					log.Printf("add publisher failed room=%s: %v", msg.RoomID, err)
					_ = client.SendJSON(map[string]any{"action": "error", "message": err.Error()})
					return
				}
				role = room.RolePublisher
			case string(room.RoleSubscriber):
				if _, err := rm.AddSubscriber(peerID, client); err != nil {
					log.Printf("add subscriber failed room=%s: %v", msg.RoomID, err)
					_ = client.SendJSON(map[string]any{"action": "error", "message": err.Error()})
					return
				}
				role = room.RoleSubscriber
			default:
				_ = client.SendJSON(map[string]any{"action": "error", "message": "role must be publisher or subscriber"})
				return
			}

			joinedRoom = rm
			log.Printf("ws join ok room=%s role=%s peer=%s", msg.RoomID, role, peerID)
			_ = client.SendJSON(map[string]any{
				"action":  "joined",
				"room_id": rm.ID,
				"role":    string(role),
				"name":    rm.Name,
			})

		case "offer":
			if joinedRoom == nil {
				_ = client.SendJSON(map[string]any{"action": "error", "message": "not joined"})
				return
			}
			log.Printf("sdp offer received room=%s peer=%s", joinedRoom.ID, peerID)
			if err := joinedRoom.HandleOffer(peerID, msg.SDP); err != nil {
				log.Printf("handle offer failed: %v", err)
				_ = client.SendJSON(map[string]any{"action": "error", "message": err.Error()})
			}

		case "answer":
			if joinedRoom == nil {
				_ = client.SendJSON(map[string]any{"action": "error", "message": "not joined"})
				return
			}
			log.Printf("sdp answer received room=%s peer=%s", joinedRoom.ID, peerID)
			if err := joinedRoom.HandleAnswer(peerID, msg.SDP); err != nil {
				log.Printf("handle answer failed: %v", err)
				_ = client.SendJSON(map[string]any{"action": "error", "message": err.Error()})
			}

		case "candidate":
			if joinedRoom == nil {
				return
			}
			if err := joinedRoom.HandleCandidate(peerID, msg.Candidate); err != nil {
				log.Printf("handle candidate failed: %v", err)
			}

		default:
			_ = client.SendJSON(map[string]any{"action": "error", "message": "unknown action"})
		}
	})

	cleanup()
	log.Printf("websocket closed peer=%s", peerID)
}

func newPeerID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
