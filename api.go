package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

const (
	maxBody       = 20 << 20 // projects may embed images as data URIs
	maxNameLen    = 200
	exportFormat  = "figmore-project"
	exportVersion = 1
)

// emptyDoc is the document of a freshly created project.
const emptyDoc = `{"version":1,"root":{"id":"root","tag":"body","style":{"display":"flex","flex-direction":"column","min-height":"100%","padding":"24px","gap":"16px","background-color":"#ffffff","font-family":"system-ui, sans-serif"},"hover":{},"attrs":{},"children":[]}}`

type API struct {
	store *Store
}

func (a *API) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/projects", a.list)
	mux.HandleFunc("POST /api/projects", a.create)
	mux.HandleFunc("POST /api/projects/import", a.importProject)
	mux.HandleFunc("GET /api/projects/{id}", a.get)
	mux.HandleFunc("PUT /api/projects/{id}", a.update)
	mux.HandleFunc("DELETE /api/projects/{id}", a.remove)
	mux.HandleFunc("POST /api/projects/{id}/duplicate", a.duplicate)
	mux.HandleFunc("GET /api/projects/{id}/export", a.export)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.As(err, new(*badRequest)):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		log.Printf("internal error: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

type badRequest struct{ msg string }

func (e *badRequest) Error() string { return e.msg }

func bad(format string, args ...any) error { return &badRequest{fmt.Sprintf(format, args...)} }

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		return nil, bad("request body too large or unreadable")
	}
	return b, nil
}

func cleanName(n string) (string, error) {
	n = strings.TrimSpace(n)
	if len(n) > maxNameLen {
		return "", bad("name too long (max %d)", maxNameLen)
	}
	return n, nil
}

// validateDoc checks that raw is a JSON object with a "root" node object.
func validateDoc(raw json.RawMessage) error {
	var d struct {
		Root *struct {
			Tag string `json:"tag"`
		} `json:"root"`
	}
	if err := json.Unmarshal(raw, &d); err != nil || d.Root == nil || d.Root.Tag == "" {
		return bad("invalid document: expected an object with a root node")
	}
	return nil
}

func (a *API) list(w http.ResponseWriter, r *http.Request) {
	ps, err := a.store.List()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, ps)
}

func (a *API) create(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name string }
	b, err := readBody(w, r)
	if err == nil && len(b) > 0 {
		if json.Unmarshal(b, &in) != nil {
			err = bad("invalid JSON")
		}
	}
	if err == nil {
		in.Name, err = cleanName(in.Name)
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	if in.Name == "" {
		in.Name = "Untitled project"
	}
	p, err := a.store.Create(in.Name, emptyDoc)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (a *API) get(w http.ResponseWriter, r *http.Request) {
	p, doc, err := a.store.Get(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"project": p, "doc": json.RawMessage(doc)})
}

func (a *API) update(w http.ResponseWriter, r *http.Request) {
	b, err := readBody(w, r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		Name *string         `json:"name"`
		Doc  json.RawMessage `json:"doc"`
	}
	if json.Unmarshal(b, &in) != nil {
		writeErr(w, bad("invalid JSON"))
		return
	}
	name, doc := "", ""
	if in.Name != nil {
		if name, err = cleanName(*in.Name); err == nil && name == "" {
			err = bad("name must not be empty")
		}
	}
	if err == nil && len(in.Doc) > 0 {
		if err = validateDoc(in.Doc); err == nil {
			doc = string(in.Doc)
		}
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	p, err := a.store.Update(r.PathValue("id"), name, doc)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, p)
}

func (a *API) remove(w http.ResponseWriter, r *http.Request) {
	if err := a.store.Delete(r.PathValue("id")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) duplicate(w http.ResponseWriter, r *http.Request) {
	p, err := a.store.Duplicate(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

var unsafeFile = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func (a *API) export(w http.ResponseWriter, r *http.Request) {
	p, doc, err := a.store.Get(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	file := strings.Trim(unsafeFile.ReplaceAllString(p.Name, "-"), "-")
	if file == "" {
		file = "project"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.figmore.json"`, file))
	json.NewEncoder(w).Encode(map[string]any{
		"format":  exportFormat,
		"version": exportVersion,
		"name":    p.Name,
		"doc":     json.RawMessage(doc),
	})
}

func (a *API) importProject(w http.ResponseWriter, r *http.Request) {
	b, err := readBody(w, r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		Format  string          `json:"format"`
		Version int             `json:"version"`
		Name    string          `json:"name"`
		Doc     json.RawMessage `json:"doc"`
	}
	if json.Unmarshal(b, &in) != nil || in.Format != exportFormat {
		writeErr(w, bad("not a figmore project file"))
		return
	}
	if in.Version > exportVersion {
		writeErr(w, bad("file version %d is newer than supported (%d)", in.Version, exportVersion))
		return
	}
	if err := validateDoc(in.Doc); err != nil {
		writeErr(w, err)
		return
	}
	name, err := cleanName(in.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	if name == "" {
		name = "Imported project"
	}
	p, err := a.store.Create(name, string(in.Doc))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}
