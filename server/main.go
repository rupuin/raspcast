package main

import (
	"net/http"
	"os"

	"github.com/rupuin/raspcast/server/auth"
	"github.com/rupuin/raspcast/server/mpv"
	"github.com/rupuin/raspcast/server/player"
	"github.com/rupuin/raspcast/server/ws"
)

func main() {
	pin := os.Getenv("PIN")
	if pin == "" {
		panic("PIN in env required")
	}

	mpvLauncher := &mpv.ExecLauncher{}
	mpvCtrl := mpv.NewController(mpvLauncher, mpv.SOCKET_PATH)
	player := player.New(mpvCtrl, mpvCtrl.Events)
	wsHub := ws.NewHub(player, player.Events)

	sessionStore := auth.NewSessionStore()
	authHandler := auth.NewHandler(sessionStore, pin)

	http.HandleFunc("POST /auth", authHandler.Login)
	http.HandleFunc("GET /auth", authHandler.Check)
	http.HandleFunc("/ws", authHandler.RequireAuth(wsHub.ServeWS))
	http.Handle("/", http.FileServer(http.Dir("./public")))

	go wsHub.Run()

	err := http.ListenAndServe(":3141", nil)
	if err != nil {
		panic(err)
	}
}
