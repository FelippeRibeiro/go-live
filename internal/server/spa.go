package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
)

// SPAHandler serves static files from root. Unknown paths fall back to index.html
// so client-side routers can handle navigation.
type SPAHandler struct {
	Root string
}

func (h SPAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	upath := path.Clean("/" + r.URL.Path)
	full := filepath.Join(h.Root, filepath.FromSlash(upath))
	if _, err := os.Stat(full); os.IsNotExist(err) {
		http.ServeFile(w, r, filepath.Join(h.Root, "index.html"))
		return
	}
	http.FileServer(http.Dir(h.Root)).ServeHTTP(w, r)
}
