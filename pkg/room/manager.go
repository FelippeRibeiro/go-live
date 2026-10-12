package room

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var (
	ErrRoomNotFound    = errors.New("room not found")
	ErrRoomExists      = errors.New("room already exists")
	ErrInvalidRoomID   = errors.New("invalid room id")
	ErrWrongPassword   = errors.New("wrong password")
	ErrPublisherExists = errors.New("publisher already connected")
	ErrLiveActive      = errors.New("live active")
	ErrNotAuthorized   = errors.New("not authorized")
)

var roomIDPattern = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)

// PublicRoom is a hub card payload for rooms without password.
type PublicRoom struct {
	RoomID  string `json:"room_id"`
	Name    string `json:"name"`
	Live    bool   `json:"live"`
	Viewers int    `json:"viewers"`
}

// Manager holds all active rooms behind an RWMutex.
type Manager struct {
	mu       sync.RWMutex
	rooms    map[string]*Room
	byIP     map[string]string // creator IP -> room id (1 sala por IP)
	onChange func()
}

// NewManager creates an empty room manager.
func NewManager() *Manager {
	return &Manager{
		rooms: make(map[string]*Room),
		byIP:  make(map[string]string),
	}
}

// SetOnChange registers a callback fired when the public hub list may change.
func (m *Manager) SetOnChange(fn func()) {
	m.mu.Lock()
	m.onChange = fn
	m.mu.Unlock()
}

func (m *Manager) notifyChange() {
	m.mu.RLock()
	fn := m.onChange
	m.mu.RUnlock()
	if fn == nil {
		return
	}
	go fn()
}

// CreateRoomInput is the payload for creating a room.
type CreateRoomInput struct {
	Name      string
	Password  string
	CreatorIP string
}

// CreateRoomResult is returned after a successful create.
type CreateRoomResult struct {
	RoomID string `json:"room_id"`
	Name   string `json:"name"`
}

// Create allocates a new room with a unique id.
// Cada IP só pode ter 1 sala; criar outra remove a anterior desse IP.
func (m *Manager) Create(in CreateRoomInput) (*CreateRoomResult, error) {
	id, err := generateRoomID()
	if err != nil {
		return nil, err
	}
	if !ValidRoomID(id) {
		return nil, ErrInvalidRoomID
	}

	name := in.Name
	if name == "" {
		name = "Live"
	}

	creatorIP := strings.TrimSpace(in.CreatorIP)
	r := NewRoom(id, name, in.Password, creatorIP)
	r.onChange = m.notifyChange

	var replaced *Room

	m.mu.Lock()
	if _, exists := m.rooms[id]; exists {
		m.mu.Unlock()
		return nil, ErrRoomExists
	}
	if creatorIP != "" {
		if oldID, ok := m.byIP[creatorIP]; ok {
			if old, exists := m.rooms[oldID]; exists {
				delete(m.rooms, oldID)
				replaced = old
			}
			delete(m.byIP, creatorIP)
		}
		m.byIP[creatorIP] = id
	}
	m.rooms[id] = r
	m.mu.Unlock()

	if replaced != nil {
		log.Printf("room replaced by same IP=%s old=%s new=%s", creatorIP, replaced.ID, id)
		replaced.Close()
	}

	log.Printf("room created id=%s name=%q password_protected=%v ip=%s", id, name, in.Password != "", creatorIP)
	m.notifyChange()
	return &CreateRoomResult{RoomID: id, Name: name}, nil
}

// Get returns a room by id.
func (m *Manager) Get(id string) (*Room, error) {
	if !ValidRoomID(id) {
		return nil, ErrInvalidRoomID
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.rooms[id]
	if !ok {
		return nil, ErrRoomNotFound
	}
	return r, nil
}

// ListPublic returns all rooms without password for the hub.
func (m *Manager) ListPublic() []PublicRoom {
	m.mu.RLock()
	rooms := make([]*Room, 0, len(m.rooms))
	for _, r := range m.rooms {
		if r.HasPassword() {
			continue
		}
		rooms = append(rooms, r)
	}
	m.mu.RUnlock()

	out := make([]PublicRoom, 0, len(rooms))
	for _, r := range rooms {
		out = append(out, r.PublicSnapshot())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Live != out[j].Live {
			return out[i].Live
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].RoomID < out[j].RoomID
	})
	return out
}

// Delete removes a room from the manager and closes it.
func (m *Manager) Delete(id string) {
	m.mu.Lock()
	r, ok := m.rooms[id]
	if ok {
		delete(m.rooms, id)
		m.clearIPLocked(r)
	}
	m.mu.Unlock()
	if ok {
		r.Close()
		log.Printf("room deleted id=%s", id)
		m.notifyChange()
	}
}

// RemoveIfEmpty deletes the room when it has no peers left.
func (m *Manager) RemoveIfEmpty(id string) {
	m.mu.Lock()
	r, ok := m.rooms[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	if !r.IsEmpty() {
		m.mu.Unlock()
		return
	}
	delete(m.rooms, id)
	m.clearIPLocked(r)
	m.mu.Unlock()
	r.Close()
	log.Printf("room cleaned (empty) id=%s", id)
	m.notifyChange()
}

func (m *Manager) clearIPLocked(r *Room) {
	if r == nil || r.CreatorIP == "" {
		return
	}
	if cur, ok := m.byIP[r.CreatorIP]; ok && cur == r.ID {
		delete(m.byIP, r.CreatorIP)
	}
}

// ValidRoomID checks alphanumerics and hyphens only.
func ValidRoomID(id string) bool {
	return id != "" && roomIDPattern.MatchString(id)
}

func generateRoomID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate room id: %w", err)
	}
	h := hex.EncodeToString(b)
	return h[:4] + "-" + h[4:], nil
}
