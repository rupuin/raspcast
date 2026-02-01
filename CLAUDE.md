# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Raspcast is a web-based remote control for mpv media player, designed to run on a Raspberry Pi. Users paste video URLs (YouTube, etc.) from their phone and the Pi plays them on a connected TV/monitor.

## Commands

```bash
# Development (with hot reload)
bun run dev

# Production
bun run start

# Deploy to Pi (pull + restart service)
./deploy.sh
```

## Architecture

**Backend** (`src/index.ts`): Single-file Bun + Hono server
- WebSocket for real-time bidirectional control (auth, play, pause, seek, volume)
- HTTP endpoints for auth cookies and history management
- Spawns mpv subprocess with IPC socket at `/tmp/mpv-socket`
- **Event-driven mpv communication**: Uses `observe_property` to subscribe to mpv state changes
- Persistent connection to mpv IPC - no polling, instant updates when properties change
- Broadcasts to clients immediately when mpv reports position/volume/pause changes

**Frontend** (`public/index.html`): Single-file vanilla HTML/CSS/JS
- PWA-ready for iOS home screen
- WebSocket client with auto-reconnect
- PIN stored in localStorage for persistent auth

**Key mpv flags** (optimized for YouTube on Pi):
- `--demuxer-thread=no`: Fixes YouTube seeking audio freeze
- `--hwdec=auto`: Hardware acceleration
- `--force-seekable=yes`: Enables seeking on network streams
- `--ytdl-format`: Prefers mp4/m4a containers, limits to 1080p

## WebSocket Protocol

All messages are JSON with a `type` field:
- `auth`: `{type: "auth", pin: string}` → `{type: "auth", ok: boolean}`
- `play`: `{type: "play", url: string}`
- `pause`: `{type: "pause"}`
- `stop`: `{type: "stop"}`
- `seek`: `{type: "seek", percent: number}` (absolute 0-100)
- `skip`: `{type: "skip", seconds: number}` (relative, e.g., -10 or +10)
- `volume`: `{type: "volume", value: number}` (0-100)
- `status`: Server broadcasts `{type: "status", data: {...}}` on every mpv property change (real-time)

## Deployment

Target: Raspberry Pi running as systemd service (`raspcast.service`)
- Service expects app at `/home/rupuin/raspcast`
- PIN configured via `Environment=PIN=xxxx` in service file
- Requires: `bun`, `mpv`, `yt-dlp`
