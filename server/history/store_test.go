package history

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestNewFileStore_MissingFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "history.json")

	store, err := NewFileStore(path, 20)
	if err != nil {
		t.Fatalf("NewFileStore() error: %v", err)
	}
	items := store.Snapshot()
	if len(items) != 0 {
		t.Fatalf("Snapshot() length: %d, expected: 0", len(items))
	}
}

func TestFileStore_LoadsPreviousItems(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "history.json")

	first, err := NewFileStore(path, 20)
	if err != nil {
		t.Fatalf("NewFileStore() error: %v", err)
	}

	item := Item{
		URL:            "http://media",
		Title:          "media",
		ResumePosition: 67,
		Duration:       100,
		LastPlayedAt:   time.Now().UTC(),
	}

	if err := first.Upsert(item); err != nil {
		t.Fatalf("Upsert() error: %v", err)
	}

	second, err := NewFileStore(path, 20)
	if err != nil {
		t.Fatalf("NewFileStore() error: %v", err)
	}

	items := second.Snapshot()
	if len(items) != 1 {
		t.Fatalf("Snapshot() length = %d, want 1", len(items))
	}

	if items[0].URL != item.URL {
		t.Fatalf("URL: %q, expected: %q", items[0].URL, item.URL)
	}
}

func TestFileStore_Upsert(t *testing.T) {
	now := time.Date(2026, time.March, 9, 20, 0, 0, 0, time.UTC)

	testCases := []struct {
		name     string
		limit    int
		existing []Item
		input    Item
		expected []Item
	}{
		{
			name:     "inserts into empty store",
			limit:    20,
			existing: []Item{},
			input:    Item{URL: "http://new", Title: "new"},
			expected: []Item{{URL: "http://new", Title: "new"}},
		},
		{
			name:  "prepends brand new item",
			limit: 20,
			existing: []Item{
				{URL: "http://existing", Title: "existing"},
				{URL: "http://existing2", Title: "existing2"},
			},
			input: Item{URL: "http://new", Title: "new"},
			expected: []Item{
				{URL: "http://new", Title: "new"},
				{URL: "http://existing", Title: "existing"},
				{URL: "http://existing2", Title: "existing2"},
			},
		},
		{
			name:  "dedupes and moves existing item to front",
			limit: 20,
			existing: []Item{
				{URL: "http://existing", Title: "existing"},
				{URL: "http://existing2", Title: "existing2"},
				{URL: "http://duplicate", Title: "duplicate"},
			},
			input: Item{URL: "http://duplicate", Title: "duplicate"},
			expected: []Item{
				{URL: "http://duplicate", Title: "duplicate"},
				{URL: "http://existing", Title: "existing"},
				{URL: "http://existing2", Title: "existing2"},
			},
		},
		{
			name:  "replaces metadata for existing item",
			limit: 20,
			existing: []Item{
				{
					URL:            "http://media",
					Title:          "old title",
					ResumePosition: 15,
					Duration:       90,
					LastPlayedAt:   now.Add(-time.Hour),
				},
				{URL: "http://other", Title: "other"},
			},
			input: Item{
				URL:            "http://media",
				Title:          "new title",
				ResumePosition: 45,
				Duration:       120,
				LastPlayedAt:   now,
			},
			expected: []Item{
				{
					URL:            "http://media",
					Title:          "new title",
					ResumePosition: 45,
					Duration:       120,
					LastPlayedAt:   now,
				},
				{URL: "http://other", Title: "other"},
			},
		},
		{
			name:  "truncates to limit",
			limit: 3,
			existing: []Item{
				{URL: "http://one", Title: "one"},
				{URL: "http://two", Title: "two"},
				{URL: "http://three", Title: "three"},
			},
			input: Item{URL: "http://new", Title: "new"},
			expected: []Item{
				{URL: "http://new", Title: "new"},
				{URL: "http://one", Title: "one"},
				{URL: "http://two", Title: "two"},
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "history.json")

			store, err := NewFileStore(path, tc.limit)
			if err != nil {
				t.Fatalf("NewFileStore() error: %v", err)
			}

			store.items = append([]Item(nil), tc.existing...)

			if err := store.Upsert(tc.input); err != nil {
				t.Fatalf("Upsert() error: %v", err)
			}

			got := store.Snapshot()
			if !reflect.DeepEqual(got, tc.expected) {
				t.Fatalf("Snapshot() = %#v, want %#v", got, tc.expected)
			}
		})
	}
}
