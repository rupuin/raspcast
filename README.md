# Raspcast

Web-based remote control for [mpv](https://mpv.io/). Point it at a URL, control playback from any browser on the network. Built for Raspberry Pi 5 but works anywhere mpv runs.

## What it is

A Go server that manages an mpv process via its IPC socket. The frontend connects over WebSocket and gets real-time playback state — position, duration, title, volume, pause. Controls (play, pause, seek, skip ±5s, volume, stop) are dispatched back to mpv. Authentication is PIN-based with a session cookie. Multiple clients can connect simultaneously and stay in sync.

Subtitle control and play history are partially built but not yet functional.

## Requirements

- mpv
- Go 1.22+
- Bun (frontend build)

## Setup

### 1. Clone and configure

```sh
git clone https://github.com/rupuin/raspcast ~/raspcast
```

Create `/etc/raspcast/env`:
```sh
PIN=1234
```

### 2. Build

```sh
cd ~/raspcast
bun install && bun run build
cd server && go build -o ../raspcast . && cd ..
```

### 3. Install as a systemd service

```sh
sudo cp raspcast.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now raspcast
```

The service file assumes user `rupuin` and path `/home/rupuin/raspcast`. Edit `raspcast.service` to match your username before copying.

## Deploying updates

From the Pi, run:

```sh
~/raspcast/deploy.sh
```

This pulls latest changes, rebuilds frontend and server, and restarts the service.

## Usage

Open `http://<host>:3141` in a browser. Enter the PIN, paste any mpv-compatible URL (YouTube, direct video, streams), and hit play.
