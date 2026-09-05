package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/FelippeRibeiro/go-live/pkg/room"
	"github.com/FelippeRibeiro/go-live/pkg/signaling"
)

func main() {
	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		if !strings.HasPrefix(p, ":") {
			p = ":" + p
		}
		addr = p
	}

	mgr := room.NewManager()
	sig := &signaling.Handler{Manager: mgr}
	hub := signaling.NewHub(mgr)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"rooms": mgr.ListPublic(),
			})
		case http.MethodPost:
			var body struct {
				Name     string `json:"name"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil && r.ContentLength != 0 {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			res, err := mgr.Create(room.CreateRoomInput{Name: body.Name, Password: body.Password})
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(res)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/ws", sig.ServeWS)
	mux.HandleFunc("/ws/hub", hub.ServeWS)

	publicDir := filepath.Join(".", "public")
	fs := http.FileServer(http.Dir(publicDir))
	mux.Handle("/", noCache(fs))

	log.Printf("mini-livestream listening on %s (CGO-free, Pion SFU)", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		next.ServeHTTP(w, r)
	})
}
