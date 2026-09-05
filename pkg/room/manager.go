package room

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"sync"
)

var (
	ErrRoomNotFound    = errors.New("room not found")
	ErrRoomExists      = errors.New("room already exists")
	ErrInvalidRoomID   = errors.New("invalid room id")
	ErrWrongPassword   = errors.New("wrong password")
	ErrPublisherExists = errors.New("publisher already connected")
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
	onChange func()
}

// NewManager creates an empty room manager.
func NewManager() *Manager {
	return &Manager{rooms: make(map[string]*Room)}
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
	if fn != nil {
		fn()
	}
}

// CreateRoomInput is the payload for creating a room.
type CreateRoomInput struct {
	Name     string
	Password string
}

// CreateRoomResult is returned after a successful create.
type CreateRoomResult struct {
	RoomID string `json:"room_id"`
	Name   string `json:"name"`
}

// Create allocates a new room with a unique id.
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

	r := NewRoom(id, name, in.Password)
	r.onChange = m.notifyChange

	m.mu.Lock()
	if _, exists := m.rooms[id]; exists {
		m.mu.Unlock()
		return nil, ErrRoomExists
	}
	m.rooms[id] = r
	m.mu.Unlock()

	log.Printf("room created id=%s name=%q password_protected=%v", id, name, in.Password != "")
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
	defer m.mu.RUnlock()
	out := make([]PublicRoom, 0, len(m.rooms))
	for _, r := range m.rooms {
		if r.HasPassword() {
			continue
		}
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
	m.mu.Unlock()
	r.Close()
	log.Printf("room cleaned (empty) id=%s", id)
	m.notifyChange()
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
