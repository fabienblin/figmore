// Command figmore serves the figmore HTML/CSS design tool.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
)

//go:embed web
var webFS embed.FS

func newHandler(store *Store) http.Handler {
	static, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", (&API{store: store}).routes())
	mux.Handle("/", noCache(http.FileServerFS(static)))
	return mux
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	dbPath := flag.String("db", "figmore.db", "SQLite database path")
	flag.Parse()

	store, err := OpenStore(*dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	log.Printf("figmore listening on http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, newHandler(store)))
}
