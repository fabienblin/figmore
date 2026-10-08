package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	_ "modernc.org/sqlite"
)

var errNotFound = errors.New("project not found")

// Project is a design project. Doc holds the raw JSON of the node tree; the
// server treats it as opaque apart from basic validation.
type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Store struct {
	db *sql.DB
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// A single connection keeps SQLite writes serialized and works for :memory:.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS projects (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			doc        TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);`); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *Store) Create(name, doc string) (Project, error) {
	now := time.Now().UnixMilli()
	p := Project{ID: newID(), Name: name, CreatedAt: now, UpdatedAt: now}
	_, err := s.db.Exec(`INSERT INTO projects (id, name, doc, created_at, updated_at) VALUES (?,?,?,?,?)`,
		p.ID, p.Name, doc, p.CreatedAt, p.UpdatedAt)
	return p, err
}

func (s *Store) List() ([]Project, error) {
	rows, err := s.db.Query(`SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) Get(id string) (Project, string, error) {
	var p Project
	var doc string
	err := s.db.QueryRow(`SELECT id, name, doc, created_at, updated_at FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &doc, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, "", errNotFound
	}
	return p, doc, err
}

// Update replaces name and/or doc (empty string means "keep").
func (s *Store) Update(id, name, doc string) (Project, error) {
	res, err := s.db.Exec(`UPDATE projects SET
		name = CASE WHEN ? = '' THEN name ELSE ? END,
		doc = CASE WHEN ? = '' THEN doc ELSE ? END,
		updated_at = ? WHERE id = ?`,
		name, name, doc, doc, time.Now().UnixMilli(), id)
	if err != nil {
		return Project{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Project{}, errNotFound
	}
	p, _, err := s.Get(id)
	return p, err
}

func (s *Store) Delete(id string) error {
	res, err := s.db.Exec(`DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

func (s *Store) Duplicate(id string) (Project, error) {
	p, doc, err := s.Get(id)
	if err != nil {
		return Project{}, err
	}
	return s.Create(p.Name+" (copy)", doc)
}
