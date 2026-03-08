package auth

import (
	"encoding/json"
	"net/http"
)

type Handler struct {
	store *SessionStore
	pin   string
}

func NewHandler(store *SessionStore, pin string) *Handler {
	return &Handler{
		store: store,
		pin:   pin,
	}
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pin string `json:"pin"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "could not decode body", http.StatusBadRequest)
		return
	}

	if body.Pin != h.pin {
		http.Error(w, "incorrect pin", http.StatusUnauthorized)
		return
	}

	token := h.store.create()
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   365 * 24 * 3600,
		Path:     "/",
	})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (h *Handler) Check(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("session")
	authenticated := err == nil && h.store.valid(cookie.Value)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"authenticated": authenticated})
}

func (h *Handler) RequireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("session")
		if err != nil || !h.store.valid(cookie.Value) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
		next(w, r)
	}
}
