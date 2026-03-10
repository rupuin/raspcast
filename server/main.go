package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

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
	mpvPlayer := player.New(mpvCtrl, mpvCtrl.Events)
	wsHub := ws.NewHub(mpvPlayer, mpvPlayer.Events)

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

	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth", authHandler.Login)
	mux.HandleFunc("GET /auth", authHandler.Check)
	mux.HandleFunc("GET /history", authHandler.RequireAuth(historyHandler.List))
	mux.HandleFunc("/ws", authHandler.RequireAuth(wsHub.ServeWS))
	mux.Handle("/", http.FileServer(http.Dir("./dist")))

	go wsHub.Run()

	srv := &http.Server{
		Addr:    ":3141",
		Handler: mux,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serverErr := make(chan error, 1)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()

	var runErr error
	select {
	case err := <-serverErr:
		runErr = err
	case <-ctx.Done():
		slog.Info("shutting down")
	}

	mpvCtrl.Stop()
	mpvPlayer.Shutdown()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown server", "err", err)
	}
	if runErr != nil {
		slog.Error("run server", "err", runErr)
		panic(runErr)
	}
}
