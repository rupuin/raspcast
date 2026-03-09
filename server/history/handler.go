package history

import (
	"encoding/json"
	"net/http"
)

type Response struct {
	Items []Item `json:"items"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type Handler struct {
	store Store
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if h.store == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(ErrorResponse{Error: "history unavailable"}); err != nil {
			http.Error(w, "failed to encode history error response", http.StatusInternalServerError)
		}
		return
	}

	if err := json.NewEncoder(w).Encode(Response{Items: h.store.Snapshot()}); err != nil {
		http.Error(w, "failed to encode history response", http.StatusInternalServerError)
	}
}
