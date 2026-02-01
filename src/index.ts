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

let mpvProcess: Subprocess | null = null;
let currentMedia: { url: string; title: string } | null = null;

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

// History endpoints (keep as HTTP for simplicity)
app.get("/api/history", requireAuth, async (c) => {
  return c.json(await loadHistory());
});

app.delete("/api/history", requireAuth, async (c) => {
  await saveHistory([]);
  broadcast({ type: "history", data: [] });
  return c.json({ ok: true });
});

// MPV command (fire and forget)
async function mpvCommand(command: any[]): Promise<boolean> {
  try {
    await Bun.connect({
      unix: MPV_SOCKET,
      socket: {
        data() {},
        open(socket) {
          socket.write(JSON.stringify({ command }) + "\n");
          socket.end();
        },
        error() {},
      },
    });
    return true;
  } catch {
    return false;
  }
}

// Get property from mpv
async function mpvGetProperty(property: string): Promise<any> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 300);
    let buffer = "";
    Bun.connect({
      unix: MPV_SOCKET,
      socket: {
        data(socket, data) {
          buffer += data.toString();
          try {
            const response = JSON.parse(buffer);
            clearTimeout(timeout);
            socket.end();
            resolve(response.data);
          } catch {}
        },
        open(socket) {
          socket.write(JSON.stringify({ command: ["get_property", property] }) + "\n");
        },
        error() {
          clearTimeout(timeout);
          resolve(null);
        },
        close() {
          clearTimeout(timeout);
        },
      },
    }).catch(() => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// Get current playback state
async function getPlaybackState() {
  if (!mpvProcess) {
    return { playing: false, current: null };
  }

  const [position, duration, paused, volume] = await Promise.all([
    mpvGetProperty("time-pos"),
    mpvGetProperty("duration"),
    mpvGetProperty("pause"),
    mpvGetProperty("volume"),
  ]);

  return {
    playing: true,
    paused: paused === true,
    current: currentMedia,
    position: position ?? 0,
    duration: duration ?? 0,
    volume: volume ?? 100,
  };
}

// Broadcast to all authenticated WS clients
function broadcast(message: any) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.data.authenticated) {
      client.send(data);
    }
  }
}

// Handle WS commands
async function handleWsCommand(ws: ServerWebSocket<{ authenticated: boolean }>, msg: any) {
  if (!ws.data.authenticated) {
    if (msg.type === "auth" && msg.pin === PIN) {
      ws.data.authenticated = true;
      ws.send(JSON.stringify({ type: "auth", ok: true }));
      // Send initial state
      ws.send(JSON.stringify({ type: "status", data: await getPlaybackState() }));
      ws.send(JSON.stringify({ type: "history", data: await loadHistory() }));
    } else {
      ws.send(JSON.stringify({ type: "auth", ok: false }));
    }
    return;
  }

  switch (msg.type) {
    case "play": {
      if (!msg.url) break;

      if (mpvProcess) {
        mpvProcess.kill();
        mpvProcess = null;
        try { await unlink(MPV_SOCKET); } catch {}
      }

      const titlePromise = fetchTitle(msg.url);

      mpvProcess = spawn({
        cmd: ["mpv", "--fullscreen", "--input-ipc-server=" + MPV_SOCKET, "--ytdl", "--volume=100", msg.url],
        stdout: "ignore",
        stderr: "ignore",
      });

      const title = await titlePromise;
      currentMedia = { url: msg.url, title };
      await addToHistory(msg.url, title);

      mpvProcess.exited.then(() => {
        mpvProcess = null;
        currentMedia = null;
        broadcast({ type: "status", data: { playing: false, current: null } });
      });

      broadcast({ type: "playing", data: { url: msg.url, title } });
      broadcast({ type: "history", data: await loadHistory() });
      break;
    }

    case "pause":
      await mpvCommand(["cycle", "pause"]);
      break;

    case "stop":
      await mpvCommand(["quit"]);
      if (mpvProcess) {
        mpvProcess.kill();
        mpvProcess = null;
      }
      currentMedia = null;
      broadcast({ type: "status", data: { playing: false, current: null } });
      break;

    case "seek":
      if (typeof msg.percent === "number") {
        await mpvCommand(["seek", msg.percent, "absolute-percent"]);
      }
      break;

    case "volume":
      if (typeof msg.value === "number") {
        const vol = Math.max(0, Math.min(150, msg.value));
        await mpvCommand(["set_property", "volume", vol]);
      }
      break;

    case "status":
      ws.send(JSON.stringify({ type: "status", data: await getPlaybackState() }));
      break;
  }
}

// State broadcast interval
let stateInterval: Timer | null = null;

function startStateBroadcast() {
  if (stateInterval) return;
  stateInterval = setInterval(async () => {
    if (wsClients.size > 0 && mpvProcess) {
      broadcast({ type: "status", data: await getPlaybackState() });
    }
  }, 500); // 500ms for smoother seek slider
}

startStateBroadcast();

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
        handleWsCommand(ws, msg);
      } catch {}
    },
    close(ws: ServerWebSocket<{ authenticated: boolean }>) {
      wsClients.delete(ws);
    },
  },
};
