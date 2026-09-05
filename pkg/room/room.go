package room

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
)

// Sender delivers signaling JSON to a connected client.
type Sender interface {
	SendJSON(v any) error
}

// PeerRole is publisher or subscriber.
type PeerRole string

const (
	RolePublisher  PeerRole = "publisher"
	RoleSubscriber PeerRole = "subscriber"
)

// Peer is a WebRTC peer bound to a signaling sender.
type Peer struct {
	ID     string
	Role   PeerRole
	PC     *webrtc.PeerConnection
	Sender Sender

	// resetting evita que Close intencional dispare remoção/stop em cascata.
	resetting atomic.Bool
}

// Room is an SFU room: one publisher, many subscribers, shared local tracks.
type Room struct {
	ID       string
	Name     string
	Password string

	mu          sync.RWMutex
	negotiateMu sync.Mutex
	publisher   *Peer
	subscribers map[string]*Peer
	tracks      map[string]*webrtc.TrackLocalStaticRTP // keyed by track kind (audio/video) + id
	closed      bool
	onChange    func()
}

// NewRoom constructs an empty room.
func NewRoom(id, name, password string) *Room {
	return &Room{
		ID:          id,
		Name:        name,
		Password:    password,
		subscribers: make(map[string]*Peer),
		tracks:      make(map[string]*webrtc.TrackLocalStaticRTP),
	}
}

func (r *Room) notifyChange() {
	if r.onChange != nil {
		r.onChange()
	}
}

// PublicSnapshot builds a hub card for this room (caller must ensure it is public).
func (r *Room) PublicSnapshot() PublicRoom {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return PublicRoom{
		RoomID:  r.ID,
		Name:    r.Name,
		Live:    len(r.tracks) > 0,
		Viewers: len(r.subscribers),
	}
}

// CheckPassword validates optional room password.
func (r *Room) CheckPassword(password string) error {
	if r.Password == "" {
		return nil
	}
	if password != r.Password {
		return ErrWrongPassword
	}
	return nil
}

// IsEmpty reports whether the room has no connected peers.
func (r *Room) IsEmpty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.publisher == nil && len(r.subscribers) == 0
}

// HasPassword reports if the room is password-protected.
func (r *Room) HasPassword() bool {
	return r.Password != ""
}

func newPeerConnection() (*webrtc.PeerConnection, error) {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}

	// NACK / TWCC / RTCP reports — sem isso o bitrate cai e a qualidade fica ruim.
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		return nil, err
	}

	se := webrtc.SettingEngine{}
	// Preferir candidatos host primeiro em LAN (menor RTT).
	se.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeUDP6,
	})

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(me),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	)
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}
	return api.NewPeerConnection(config)
}

// AddPublisher creates the publisher peer connection.
func (r *Room) AddPublisher(peerID string, sender Sender) (*Peer, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, ErrRoomNotFound
	}
	if r.publisher != nil {
		return nil, ErrPublisherExists
	}

	pc, err := newPeerConnection()
	if err != nil {
		return nil, err
	}

	peer := &Peer{ID: peerID, Role: RolePublisher, PC: pc, Sender: sender}
	r.publisher = peer

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cand := c.ToJSON()
		_ = sender.SendJSON(map[string]any{
			"action": "candidate",
			"candidate": map[string]any{
				"candidate":     cand.Candidate,
				"sdpMid":        cand.SDPMid,
				"sdpMLineIndex": cand.SDPMLineIndex,
			},
		})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("publisher pc state room=%s peer=%s state=%s", r.ID, peerID, state.String())
		if peer.resetting.Load() || peer.PC != pc {
			return
		}
		// PC caiu mas o WebSocket do host pode continuar — só encerra a mídia.
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			r.StopStream(peerID)
		}
	})

	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		r.handlePublisherTrack(remote, receiver)
	})

	log.Printf("publisher joined room=%s peer=%s", r.ID, peerID)
	return peer, nil
}

func (r *Room) handlePublisherTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	log.Printf("publisher track room=%s kind=%s id=%s", r.ID, remote.Kind().String(), remote.ID())

	local, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		remote.ID(),
		remote.StreamID(),
	)
	if err != nil {
		log.Printf("create local track: %v", err)
		return
	}

	key := trackKey(remote)
	r.mu.Lock()
	r.tracks[key] = local
	subs := make([]*Peer, 0, len(r.subscribers))
	for _, s := range r.subscribers {
		subs = append(subs, s)
	}
	r.mu.Unlock()
	r.notifyChange()

	for _, sub := range subs {
		if err := r.addTrackAndNegotiate(sub, local); err != nil {
			log.Printf("attach track to subscriber %s: %v", sub.ID, err)
		}
	}

	// Drain inbound RTCP so the buffer does not stall the track.
	go func() {
		for {
			if _, _, rtcpErr := receiver.Read(make([]byte, 1500)); rtcpErr != nil {
				return
			}
		}
	}()

	// PLI frequente: keyframes rápidos para late joiners e recuperação de perda.
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_ = r.sendPLI(remote.SSRC())
			}
		}
	}()

	for {
		pkt, _, readErr := remote.ReadRTP()
		if readErr != nil {
			close(done)
			if readErr != io.EOF {
				log.Printf("publisher track read ended room=%s: %v", r.ID, readErr)
			}
			return
		}
		if writeErr := local.WriteRTP(pkt); writeErr != nil && writeErr != io.ErrClosedPipe {
			close(done)
			log.Printf("local track write: %v", writeErr)
			return
		}
	}
}

func (r *Room) sendPLI(ssrc webrtc.SSRC) error {
	r.mu.RLock()
	pub := r.publisher
	r.mu.RUnlock()
	if pub == nil || pub.PC == nil {
		return nil
	}
	return pub.PC.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: uint32(ssrc)},
	})
}

func trackKey(remote *webrtc.TrackRemote) string {
	return fmt.Sprintf("%s:%s", remote.Kind().String(), remote.ID())
}

func (r *Room) addTrackAndNegotiate(sub *Peer, track *webrtc.TrackLocalStaticRTP) error {
	if _, err := sub.PC.AddTrack(track); err != nil {
		return err
	}
	return r.negotiateSubscriber(sub)
}

func (r *Room) negotiateSubscriber(sub *Peer) error {
	r.negotiateMu.Lock()
	defer r.negotiateMu.Unlock()

	offer, err := sub.PC.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err := sub.PC.SetLocalDescription(offer); err != nil {
		return err
	}
	log.Printf("sending offer to subscriber room=%s peer=%s", r.ID, sub.ID)
	return sub.Sender.SendJSON(map[string]any{
		"action": "offer",
		"sdp":    offer.SDP,
		"type":   offer.Type.String(),
	})
}

// AddSubscriber creates a subscriber peer and attaches existing tracks.
func (r *Room) AddSubscriber(peerID string, sender Sender) (*Peer, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, ErrRoomNotFound
	}

	pc, err := newPeerConnection()
	if err != nil {
		return nil, err
	}

	peer := &Peer{ID: peerID, Role: RoleSubscriber, PC: pc, Sender: sender}
	r.subscribers[peerID] = peer

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cand := c.ToJSON()
		_ = sender.SendJSON(map[string]any{
			"action": "candidate",
			"candidate": map[string]any{
				"candidate":     cand.Candidate,
				"sdpMid":        cand.SDPMid,
				"sdpMLineIndex": cand.SDPMLineIndex,
			},
		})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("subscriber pc state room=%s peer=%s state=%s", r.ID, peerID, state.String())
		// Remoção de guest só via WebSocket disconnect — fecha/reset de PC não tira da sala.
	})

	tracks := make([]*webrtc.TrackLocalStaticRTP, 0, len(r.tracks))
	for _, t := range r.tracks {
		tracks = append(tracks, t)
	}

	log.Printf("subscriber joined room=%s peer=%s tracks=%d", r.ID, peerID, len(tracks))
	r.notifyChange()

	// Negotiate after unlock via goroutine so join response can go first.
	if len(tracks) > 0 {
		go func() {
			for _, t := range tracks {
				if _, err := peer.PC.AddTrack(t); err != nil {
					log.Printf("add track to %s: %v", peerID, err)
					return
				}
			}
			if err := r.negotiateSubscriber(peer); err != nil {
				log.Printf("negotiate subscriber %s: %v", peerID, err)
			}
		}()
	}

	return peer, nil
}

// HandleOffer processes an SDP offer from a peer.
func (r *Room) HandleOffer(peerID string, sdp string) error {
	peer, err := r.getPeer(peerID)
	if err != nil {
		return err
	}

	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}
	if err := peer.PC.SetRemoteDescription(offer); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}

	answer, err := peer.PC.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}
	if err := peer.PC.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}

	log.Printf("sdp answer room=%s peer=%s role=%s", r.ID, peerID, peer.Role)
	return peer.Sender.SendJSON(map[string]any{
		"action": "answer",
		"sdp":    answer.SDP,
		"type":   answer.Type.String(),
	})
}

// HandleAnswer processes an SDP answer from a subscriber.
func (r *Room) HandleAnswer(peerID string, sdp string) error {
	peer, err := r.getPeer(peerID)
	if err != nil {
		return err
	}
	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}
	if err := peer.PC.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("set remote answer: %w", err)
	}
	log.Printf("sdp answer applied room=%s peer=%s", r.ID, peerID)
	return nil
}

// CandidatePayload matches the signaling JSON candidate object.
type CandidatePayload struct {
	Candidate     string  `json:"candidate"`
	SDPMid        *string `json:"sdpMid"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex"`
}

// HandleCandidate adds a remote ICE candidate.
func (r *Room) HandleCandidate(peerID string, raw json.RawMessage) error {
	peer, err := r.getPeer(peerID)
	if err != nil {
		return err
	}
	var c CandidatePayload
	if err := json.Unmarshal(raw, &c); err != nil {
		return fmt.Errorf("parse candidate: %w", err)
	}
	init := webrtc.ICECandidateInit{
		Candidate:     c.Candidate,
		SDPMid:        c.SDPMid,
		SDPMLineIndex: c.SDPMLineIndex,
	}
	if err := peer.PC.AddICECandidate(init); err != nil {
		return fmt.Errorf("add ice candidate: %w", err)
	}
	return nil
}

func (r *Room) getPeer(peerID string) (*Peer, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.publisher != nil && r.publisher.ID == peerID {
		return r.publisher, nil
	}
	if s, ok := r.subscribers[peerID]; ok {
		return s, nil
	}
	return nil, ErrNotAuthorized
}

// StopStream ends the current broadcast but keeps the publisher in the room
// so they can start sharing again without rejoining.
func (r *Room) StopStream(peerID string) {
	r.mu.Lock()
	if r.publisher == nil || r.publisher.ID != peerID {
		r.mu.Unlock()
		return
	}
	pub := r.publisher
	if pub.resetting.Load() {
		r.mu.Unlock()
		return
	}

	hadMedia := len(r.tracks) > 0
	pcState := webrtc.PeerConnectionStateNew
	if pub.PC != nil {
		pcState = pub.PC.ConnectionState()
	}
	needReset := hadMedia ||
		pcState == webrtc.PeerConnectionStateClosed ||
		pcState == webrtc.PeerConnectionStateFailed
	if !needReset {
		r.mu.Unlock()
		return
	}

	r.tracks = make(map[string]*webrtc.TrackLocalStaticRTP)
	subs := make([]*Peer, 0, len(r.subscribers))
	for _, s := range r.subscribers {
		subs = append(subs, s)
	}
	r.mu.Unlock()

	log.Printf("stream stopped room=%s peer=%s subscribers=%d had_media=%v", r.ID, peerID, len(subs), hadMedia)

	if hadMedia {
		for _, s := range subs {
			_ = s.Sender.SendJSON(map[string]any{
				"action":  "ended",
				"message": "stream stopped",
			})
			if err := r.resetSubscriberPC(s); err != nil {
				log.Printf("reset subscriber pc room=%s peer=%s: %v", r.ID, s.ID, err)
			}
		}
	}

	if err := r.resetPublisherPC(pub); err != nil {
		log.Printf("reset publisher pc room=%s peer=%s: %v", r.ID, peerID, err)
	}
	r.notifyChange()
}

func (r *Room) resetPublisherPC(pub *Peer) error {
	pub.resetting.Store(true)
	defer pub.resetting.Store(false)

	if pub.PC != nil {
		_ = pub.PC.Close()
	}

	pc, err := newPeerConnection()
	if err != nil {
		return err
	}
	pub.PC = pc
	peerID := pub.ID
	sender := pub.Sender

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cand := c.ToJSON()
		_ = sender.SendJSON(map[string]any{
			"action": "candidate",
			"candidate": map[string]any{
				"candidate":     cand.Candidate,
				"sdpMid":        cand.SDPMid,
				"sdpMLineIndex": cand.SDPMLineIndex,
			},
		})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("publisher pc state room=%s peer=%s state=%s", r.ID, peerID, state.String())
		if pub.resetting.Load() || pub.PC != pc {
			return
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			r.StopStream(peerID)
		}
	})

	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		r.handlePublisherTrack(remote, receiver)
	})
	return nil
}

// RemovePublisher tears down the publisher and stream, but keeps subscribers in the room.
func (r *Room) RemovePublisher(peerID string) {
	r.mu.Lock()
	if r.publisher == nil || r.publisher.ID != peerID {
		r.mu.Unlock()
		return
	}
	pub := r.publisher
	r.publisher = nil
	r.tracks = make(map[string]*webrtc.TrackLocalStaticRTP)
	subs := make([]*Peer, 0, len(r.subscribers))
	for _, s := range r.subscribers {
		subs = append(subs, s)
	}
	r.mu.Unlock()

	pub.resetting.Store(true)
	if pub.PC != nil {
		_ = pub.PC.Close()
	}

	log.Printf("publisher left room=%s peer=%s — keeping %d subscribers", r.ID, peerID, len(subs))
	for _, s := range subs {
		_ = s.Sender.SendJSON(map[string]any{
			"action":  "ended",
			"message": "publisher disconnected",
		})
		if err := r.resetSubscriberPC(s); err != nil {
			log.Printf("reset subscriber pc room=%s peer=%s: %v", r.ID, s.ID, err)
		}
	}
	r.notifyChange()
}

// resetSubscriberPC closes the old PC and attaches a fresh one for future offers.
func (r *Room) resetSubscriberPC(sub *Peer) error {
	sub.resetting.Store(true)
	defer sub.resetting.Store(false)

	if sub.PC != nil {
		_ = sub.PC.Close()
	}
	pc, err := newPeerConnection()
	if err != nil {
		return err
	}
	sub.PC = pc
	sender := sub.Sender
	peerID := sub.ID

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cand := c.ToJSON()
		_ = sender.SendJSON(map[string]any{
			"action": "candidate",
			"candidate": map[string]any{
				"candidate":     cand.Candidate,
				"sdpMid":        cand.SDPMid,
				"sdpMLineIndex": cand.SDPMLineIndex,
			},
		})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("subscriber pc state room=%s peer=%s state=%s", r.ID, peerID, state.String())
	})
	return nil
}

// RemoveSubscriber removes one viewer.
func (r *Room) RemoveSubscriber(peerID string) {
	r.mu.Lock()
	sub, ok := r.subscribers[peerID]
	if ok {
		delete(r.subscribers, peerID)
	}
	r.mu.Unlock()
	if !ok {
		return
	}
	if sub.PC != nil {
		_ = sub.PC.Close()
	}
	log.Printf("subscriber left room=%s peer=%s", r.ID, peerID)
	r.notifyChange()
}

// Close shuts down all peers in the room.
func (r *Room) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	pub := r.publisher
	r.publisher = nil
	subs := r.subscribers
	r.subscribers = make(map[string]*Peer)
	r.tracks = make(map[string]*webrtc.TrackLocalStaticRTP)
	r.mu.Unlock()

	if pub != nil && pub.PC != nil {
		_ = pub.PC.Close()
	}
	for _, s := range subs {
		_ = s.Sender.SendJSON(map[string]any{
			"action":  "ended",
			"message": "room closed",
		})
		if s.PC != nil {
			_ = s.PC.Close()
		}
	}
}
