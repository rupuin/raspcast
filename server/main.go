package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/rupuin/raspcast/server/auth"
	"github.com/rupuin/raspcast/server/history"
	"github.com/rupuin/raspcast/server/mpv"
	"github.com/rupuin/raspcast/server/player"
	"github.com/rupuin/raspcast/server/ws"
)

func main() {
	pin := os.Getenv("PIN")
	if pin == "" {
		panic("PIN in env required")
	}

	historyPath := os.Getenv("HISTORY_STORE_PATH")
	mpvLauncher := &mpv.ExecLauncher{}
	mpvCtrl := mpv.NewController(mpvLauncher, mpv.SOCKET_PATH)
	player := player.New(mpvCtrl, mpvCtrl.Events)
	wsHub := ws.NewHub(player, player.Events)

	var historyStore history.Store
	if historyPath == "" {
		slog.Warn("history store disabled: HISTORY_STORE_PATH not set")
	} else {
		store, err := history.NewFileStore(historyPath, 20)
		if err != nil {
			slog.Error("create history file store", "err", err)
		} else {
			historyStore = store
		}
	}

	historyHandler := history.NewHandler(historyStore)
	sessionStore := auth.NewSessionStore()
	authHandler := auth.NewHandler(sessionStore, pin)

	http.HandleFunc("POST /auth", authHandler.Login)
	http.HandleFunc("GET /auth", authHandler.Check)
	http.HandleFunc("GET /history", authHandler.RequireAuth(historyHandler.List))
	http.HandleFunc("/ws", authHandler.RequireAuth(wsHub.ServeWS))
	http.Handle("/", http.FileServer(http.Dir("./dist")))

	go wsHub.Run()

	err := http.ListenAndServe(":3141", nil)
	if err != nil {
		panic(err)
	}
}
