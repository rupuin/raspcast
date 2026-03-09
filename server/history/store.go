package history

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Item struct {
	URL            string    `json:"url"`
	Title          string    `json:"title,omitempty"`
	ResumePosition float64   `json:"resumePosition"`
	Duration       float64   `json:"duration,omitempty"`
	LastPlayedAt   time.Time `json:"lastPlayedAt"`
}

type Store interface {
	Snapshot() []Item
	Upsert(item Item) error
}

type FileStore struct {
	mu    sync.Mutex
	path  string
	limit int
	items []Item
}

func NewFileStore(path string, limit int) (*FileStore, error) {
	if path == "" {
		return nil, fmt.Errorf("history file path required")
	}

	dir := filepath.Dir(path)
	info, err := os.Stat(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("history file directory does not exist: %s", dir)
		}
		return nil, err
	}

	if !info.IsDir() {
		return nil, fmt.Errorf("history file parent is not a directory: %s", dir)
	}

	store := &FileStore{
		path:  path,
		limit: limit,
		items: []Item{},
	}

	if err := store.load(); err != nil {
		return nil, err
	}

	return store, nil
}

func (s *FileStore) Snapshot() []Item {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]Item, len(s.items))
	copy(out, s.items)
	return out
}

func (s *FileStore) Upsert(item Item) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	next := make([]Item, 0, len(s.items)+1)
	next = append(next, item)

	for _, existing := range s.items {
		if existing.URL == item.URL {
			continue
		}

		next = append(next, existing)
		if s.limit > 0 && len(next) >= s.limit {
			break
		}
	}

	s.items = next
	return s.saveLocked()
}

func (s *FileStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			s.items = []Item{}
			return nil
		}
		return err
	}

	if len(data) == 0 {
		s.items = []Item{}
		return nil
	}

	var items []Item
	if err := json.Unmarshal(data, &items); err != nil {
		return err
	}

	if s.limit > 0 && len(items) > s.limit {
		items = items[:s.limit]
	}

	s.items = items
	return nil
}

func (s *FileStore) saveLocked() error {
	data, err := json.MarshalIndent(s.items, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal history: %w", err)
	}

	data = append(data, '\n')
	dir := filepath.Dir(s.path)

	tmp, err := os.CreateTemp(dir, "history-*.json")
	if err != nil {
		return fmt.Errorf("create temp history file: %w", err)
	}

	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp history file: %w", err)
	}

	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp history file: %w", err)
	}

	if err := os.Rename(tmpPath, s.path); err != nil {
		return fmt.Errorf("replace history file: %w", err)
	}

	cleanup = false
	return nil
}
