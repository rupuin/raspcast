import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie, setCookie } from "hono/cookie";
import { spawn, type Subprocess, type ServerWebSocket } from "bun";
import { unlink, readFile, writeFile } from "node:fs/promises";

const app = new Hono();
const PORT = 3141;
const PIN = process.env.PIN || "1234";
const MPV_SOCKET = "/tmp/mpv-socket";
const HISTORY_FILE = "./history.json";
const MAX_HISTORY = 10;
const MAX_SUBTITLE_SIZE_BYTES = 5 * 1024 * 1024;
const SUBTITLE_EXTENSIONS = new Set(["vtt", "srt", "ass", "ssa", "sub", "txt"]);

let mpvProcess: Subprocess | null = null;
let mpvSocket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never | null = null;
let currentMedia: { url: string; title: string } | null = null;
const subtitleTempFiles = new Set<string>();

// Current playback state (updated by mpv property observers)
const playbackState = {
  playing: false,
  paused: false,
  position: 0,
  duration: 0,
  volume: 100,
  subtitles: [] as { id: number; lang: string; title: string; selected: boolean }[],
  subtitleEnabled: true,
};

// Connected WebSocket clients
const wsClients = new Set<ServerWebSocket<{ authenticated: boolean }>>();

interface HistoryItem {
  url: string;
  title: string;
  timestamp: number;
}

async function loadHistory(): Promise<HistoryItem[]> {
  try {
    const data = await readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveHistory(history: HistoryItem[]): Promise<void> {
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function addToHistory(url: string, title: string): Promise<void> {
  const history = await loadHistory();
  const filtered = history.filter((h) => h.url !== url);
  filtered.unshift({ url, title, timestamp: Date.now() });
  await saveHistory(filtered.slice(0, MAX_HISTORY));
}

async function cleanupSubtitleFiles(): Promise<void> {
  const files = [...subtitleTempFiles];
  subtitleTempFiles.clear();
  await Promise.all(files.map((file) => unlink(file).catch(() => {})));
}

function guessSubtitleExtension(url: URL, contentType: string | null): string {
  const mime = (contentType || "").toLowerCase();
  if (mime.includes("vtt")) return "vtt";
  if (mime.includes("srt") || mime.includes("subrip")) return "srt";
  if (mime.includes("ass")) return "ass";
  if (mime.includes("ssa")) return "ssa";

  const match = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = match?.[1];
  if (ext && SUBTITLE_EXTENSIONS.has(ext)) return ext;
  return "vtt";
}

async function downloadSubtitle(urlText: string): Promise<string> {
  let subtitleUrl: URL;
  try {
    subtitleUrl = new URL(urlText);
  } catch {
    throw new Error("Invalid subtitle URL");
  }

  if (subtitleUrl.protocol !== "https:" && subtitleUrl.protocol !== "http:") {
    throw new Error("Subtitle URL must start with http:// or https://");
  }

  const res = await fetch(subtitleUrl.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Raspcast/1.0)" },
  });

  if (!res.ok) {
    throw new Error(`Subtitle download failed (${res.status})`);
  }

  const lengthHeader = Number(res.headers.get("content-length") || 0);
  if (lengthHeader > MAX_SUBTITLE_SIZE_BYTES) {
    throw new Error("Subtitle file is too large");
  }

  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength === 0) {
    throw new Error("Subtitle file is empty");
  }
  if (data.byteLength > MAX_SUBTITLE_SIZE_BYTES) {
    throw new Error("Subtitle file is too large");
  }

  const ext = guessSubtitleExtension(subtitleUrl, res.headers.get("content-type"));
  const filePath = `/tmp/raspcast-sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  await writeFile(filePath, data);
  subtitleTempFiles.add(filePath);
  return filePath;
}

async function fetchTitle(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Raspcast/1.0)" },
    });
    clearTimeout(timeout);
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match) {
      return match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
    }
  } catch {}
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url.slice(0, 50);
  }
}

// Auth middleware for HTTP
const requireAuth = async (c: any, next: any) => {
  const token = getCookie(c, "auth");
  if (token !== PIN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

// Static files
app.use("/*", serveStatic({ root: "./public" }));

// Auth endpoints
app.post("/api/auth", async (c) => {
  const { pin } = await c.req.json();
  if (pin === PIN) {
    setCookie(c, "auth", PIN, {
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 60 * 60 * 24 * 365,
    });
    return c.json({ ok: true });
  }
  return c.json({ error: "invalid pin" }, 401);
});

app.get("/api/auth", async (c) => {
  const token = getCookie(c, "auth");
  return c.json({ authenticated: token === PIN });
});

// History endpoints
app.get("/api/history", requireAuth, async (c) => {
  return c.json(await loadHistory());
});

app.delete("/api/history", requireAuth, async (c) => {
  await saveHistory([]);
  broadcast({ type: "history", data: [] });
  return c.json({ ok: true });
});

// HTTP Command endpoint (more reliable than WS for commands)
app.post("/api/cmd", requireAuth, async (c) => {
  const body = await c.req.json();
  console.log("[cmd]", body.type, body.url ? body.url.slice(0, 80) + "..." : "");
  try {
    await handleCommand(body);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command failed";
    console.error("[cmd] Failed:", message);
    return c.json({ error: message }, 400);
  }
});

// Broadcast to all authenticated WS clients
function broadcast(message: any) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.data.authenticated) {
      client.send(data);
    }
  }
}

// Broadcast current playback state
function broadcastStatus() {
  broadcast({
    type: "status",
    data: {
      playing: playbackState.playing,
      paused: playbackState.paused,
      current: currentMedia,
      position: playbackState.position,
      duration: playbackState.duration,
      volume: playbackState.volume,
      subtitles: playbackState.subtitles,
      subtitleEnabled: playbackState.subtitleEnabled,
    },
  });
}

// Handle property change events from mpv
function handleMpvEvent(msg: any) {
  if (msg.event === "property-change") {
    switch (msg.name) {
      case "time-pos":
        if (typeof msg.data === "number") {
          playbackState.position = msg.data;
        }
        break;
      case "duration":
        if (typeof msg.data === "number") {
          playbackState.duration = msg.data;
        }
        break;
      case "pause":
        playbackState.paused = msg.data === true;
        break;
      case "volume":
        if (typeof msg.data === "number") {
          playbackState.volume = Math.min(100, msg.data);
        }
        break;
      case "track-list":
        if (Array.isArray(msg.data)) {
          playbackState.subtitles = msg.data
            .filter((t: any) => t.type === "sub")
            .map((t: any) => ({
              id: t.id,
              lang: t.lang || "unknown",
              title: t.title || t.lang || `Track ${t.id}`,
              selected: t.selected || false,
            }));
          console.log("[mpv] Subtitle tracks:", playbackState.subtitles.length);
        }
        break;
      case "sub-visibility":
        playbackState.subtitleEnabled = msg.data === true;
        break;
    }
    // Broadcast on every property change for real-time updates
    broadcastStatus();
  }
}

// Connect to mpv IPC socket and subscribe to property changes
async function connectToMpv(): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, 1000);

    Bun.connect({
      unix: MPV_SOCKET,
      socket: {
        data(socket, data) {
          buffer += data.toString();
          // Parse newline-delimited JSON messages
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              handleMpvEvent(msg);
            } catch {}
          }
        },
        open(socket) {
          console.log("[mpv] IPC connected");
          mpvSocket = socket;
          playbackState.playing = true;

          // Subscribe to property changes
          socket.write(JSON.stringify({ command: ["observe_property", 1, "time-pos"] }) + "\n");
          socket.write(JSON.stringify({ command: ["observe_property", 2, "duration"] }) + "\n");
          socket.write(JSON.stringify({ command: ["observe_property", 3, "pause"] }) + "\n");
          socket.write(JSON.stringify({ command: ["observe_property", 4, "volume"] }) + "\n");
          socket.write(JSON.stringify({ command: ["observe_property", 5, "track-list"] }) + "\n");
          socket.write(JSON.stringify({ command: ["observe_property", 6, "sub-visibility"] }) + "\n");

          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve(true);
          }
        },
        close() {
          mpvSocket = null;
          playbackState.playing = false;
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
        },
        error() {
          mpvSocket = null;
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
        },
      },
    }).catch(() => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}

// Send command to mpv
function mpvCommand(command: any[]): boolean {
  if (mpvSocket) {
    mpvSocket.write(JSON.stringify({ command }) + "\n");
    return true;
  }
  return false;
}

// Get current playback state (for initial sync)
function getPlaybackState() {
  return {
    playing: playbackState.playing,
    paused: playbackState.paused,
    current: currentMedia,
    position: playbackState.position,
    duration: playbackState.duration,
    volume: playbackState.volume,
    subtitles: playbackState.subtitles,
    subtitleEnabled: playbackState.subtitleEnabled,
  };
}

// Handle commands (shared between HTTP and WS)
async function handleCommand(msg: any) {
  switch (msg.type) {
    case "play": {
      if (!msg.url) {
        console.log("[play] No URL provided");
        break;
      }
      console.log("[play] Starting:", msg.url.slice(0, 100));

      // Close existing mpv connection
      if (mpvSocket) {
        mpvSocket.end();
        mpvSocket = null;
      }

      // Kill existing mpv process and wait for it to fully exit
      if (mpvProcess) {
        console.log("[mpv] Terminating existing process...");
        const oldProcess = mpvProcess;
        mpvProcess = null; // Clear reference immediately
        oldProcess.kill();
        await oldProcess.exited; // Wait for it to actually exit
        try { await unlink(MPV_SOCKET); } catch {}
        console.log("[mpv] Old process terminated");
      }

      // Reset state
      await cleanupSubtitleFiles();
      playbackState.playing = false;
      playbackState.paused = false;
      playbackState.position = 0;
      playbackState.duration = 0;
      playbackState.volume = 100;
      playbackState.subtitles = [];
      playbackState.subtitleEnabled = true;

      const titlePromise = fetchTitle(msg.url);

      mpvProcess = spawn({
        cmd: [
          "mpv",
          "--fullscreen",
          "--input-ipc-server=" + MPV_SOCKET,
          "--ytdl",
          "--volume=100",

          // HARDWARE ACCELERATION (RPi5)
          "--hwdec=auto-safe",

          // CACHING - pause if buffer runs low instead of slow-mo
          "--cache=yes",
          "--cache-secs=60",
          "--cache-pause=yes",
          "--cache-pause-wait=5",
          "--demuxer-max-bytes=300MiB",
          "--demuxer-max-back-bytes=150MiB",
          "--demuxer-readahead-secs=60",

          // PERFORMANCE
          "--framedrop=vo",

          // AUDIO
          "--audio-buffer=1",

          // NETWORK
          "--network-timeout=30",
          "--force-seekable=yes",

          // YOUTUBE: Prefer H.264 (hardware decoded) over VP9/AV1
          "--ytdl-format=bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080][vcodec^=avc1]+bestaudio/best[height<=1080]",

          msg.url,
        ],
        stdout: "ignore",
        stderr: "ignore",
      });

      const title = await titlePromise;
      currentMedia = { url: msg.url, title };
      await addToHistory(msg.url, title);

      // Wait for mpv socket to be ready, then connect
      const tryConnect = async (attempts = 0): Promise<void> => {
        if (attempts > 20) return; // Give up after 2 seconds
        const connected = await connectToMpv();
        if (!connected && mpvProcess) {
          await new Promise((r) => setTimeout(r, 100));
          return tryConnect(attempts + 1);
        }
      };

      // Start connection attempts
      setTimeout(() => tryConnect(), 100);

      mpvProcess.exited.then(async (code) => {
        console.log("[mpv] Exited with code:", code);
        if (mpvSocket) {
          mpvSocket.end();
          mpvSocket = null;
        }
        mpvProcess = null;
        currentMedia = null;
        playbackState.playing = false;
        playbackState.paused = false;
        playbackState.position = 0;
        playbackState.duration = 0;
        playbackState.subtitles = [];
        playbackState.subtitleEnabled = true;
        await cleanupSubtitleFiles();
        broadcast({ type: "status", data: { playing: false, current: null } });
      });

      broadcast({ type: "playing", data: { url: msg.url, title } });
      broadcast({ type: "history", data: await loadHistory() });
      break;
    }

    case "pause":
      mpvCommand(["cycle", "pause"]);
      break;

    case "stop":
      mpvCommand(["quit"]);
      if (mpvSocket) {
        mpvSocket.end();
        mpvSocket = null;
      }
      if (mpvProcess) {
        mpvProcess.kill();
        mpvProcess = null;
      }
      currentMedia = null;
      playbackState.playing = false;
      playbackState.subtitles = [];
      playbackState.subtitleEnabled = true;
      await cleanupSubtitleFiles();
      broadcast({ type: "status", data: { playing: false, current: null } });
      break;

    case "kill":
      // Force kill (SIGKILL) - use when stop doesn't work
      if (mpvSocket) {
        mpvSocket.end();
        mpvSocket = null;
      }
      if (mpvProcess) {
        mpvProcess.kill(9); // SIGKILL
        mpvProcess = null;
      }
      currentMedia = null;
      playbackState.playing = false;
      playbackState.subtitles = [];
      playbackState.subtitleEnabled = true;
      await cleanupSubtitleFiles();
      broadcast({ type: "status", data: { playing: false, current: null } });
      break;

    case "seek":
      if (typeof msg.percent === "number") {
        mpvCommand(["seek", msg.percent, "absolute-percent"]);
      }
      break;

    case "skip":
      if (typeof msg.seconds === "number") {
        mpvCommand(["seek", msg.seconds, "relative"]);
      }
      break;

    case "volume":
      if (typeof msg.value === "number") {
        const vol = Math.max(0, Math.min(100, msg.value));
        mpvCommand(["set_property", "volume", vol]);
      }
      break;

    case "sub-add":
      // Add subtitle from URL
      if (typeof msg.url === "string" && msg.url.trim()) {
        if (!mpvSocket) {
          throw new Error("Nothing is currently playing");
        }

        const subtitleUrl = msg.url.trim();
        console.log("[sub] Adding subtitle:", subtitleUrl.slice(0, 80));

        const filePath = await downloadSubtitle(subtitleUrl);
        const added = mpvCommand(["sub-add", filePath, "select"]);
        if (!added) {
          subtitleTempFiles.delete(filePath);
          await unlink(filePath).catch(() => {});
          throw new Error("Failed to add subtitle track");
        }
        mpvCommand(["set_property", "sub-visibility", true]);
      }
      break;

    case "sub-select":
      // Select subtitle track by ID (or "no" to disable)
      if (msg.id === "no") {
        mpvCommand(["set_property", "sid", "no"]);
      } else if (typeof msg.id === "number") {
        mpvCommand(["set_property", "sid", msg.id]);
      }
      break;

    case "sub-toggle":
      // Toggle subtitle visibility
      mpvCommand(["cycle", "sub-visibility"]);
      break;
  }
}

// Handle WS messages (auth + commands)
async function handleWsMessage(ws: ServerWebSocket<{ authenticated: boolean }>, msg: any) {
  if (!ws.data.authenticated) {
    if (msg.type === "auth" && msg.pin === PIN) {
      ws.data.authenticated = true;
      ws.send(JSON.stringify({ type: "auth", ok: true }));
      // Send initial state
      ws.send(JSON.stringify({ type: "status", data: getPlaybackState() }));
      ws.send(JSON.stringify({ type: "history", data: await loadHistory() }));
    } else {
      ws.send(JSON.stringify({ type: "auth", ok: false }));
    }
    return;
  }

  // Status request returns directly to requester
  if (msg.type === "status") {
    ws.send(JSON.stringify({ type: "status", data: getPlaybackState() }));
    return;
  }

  // All other commands
  try {
    await handleCommand(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command failed";
    ws.send(JSON.stringify({ type: "error", error: message }));
  }
}

console.log(`Raspcast running on http://0.0.0.0:${PORT}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req: Request, server: any) {
    // Handle WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
      const success = server.upgrade(req, { data: { authenticated: false } });
      return success ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
    }
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: ServerWebSocket<{ authenticated: boolean }>) {
      wsClients.add(ws);
    },
    message(ws: ServerWebSocket<{ authenticated: boolean }>, message: string) {
      try {
        const msg = JSON.parse(message);
        handleWsMessage(ws, msg);
      } catch {}
    },
    close(ws: ServerWebSocket<{ authenticated: boolean }>) {
      wsClients.delete(ws);
    },
  },
};
