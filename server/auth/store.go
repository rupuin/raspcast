package auth

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

type SessionStore struct {
	tokens map[string]struct{}
	mu     sync.RWMutex
}

func NewSessionStore() *SessionStore {
	return &SessionStore{
		tokens: make(map[string]struct{}),
	}
}

func (ss *SessionStore) create() string {
	token := generate32Hex()
	ss.mu.Lock()
	defer ss.mu.Unlock()
	ss.tokens[token] = struct{}{}
	return token
}

func (ss *SessionStore) valid(token string) bool {
	ss.mu.RLock()
	defer ss.mu.RUnlock()
	_, ok := ss.tokens[token]
	return ok
}

func generate32Hex() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}
