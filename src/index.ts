import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie, setCookie } from "hono/cookie";
import { spawn, type Subprocess } from "bun";
import { unlink, readFile, writeFile } from "node:fs/promises";

const app = new Hono();
const PORT = 3141;
const PIN = process.env.PIN || "1234";
const MPV_SOCKET = "/tmp/mpv-socket";
const HISTORY_FILE = "./history.json";
const MAX_HISTORY = 10;

let mpvProcess: Subprocess | null = null;
let currentMedia: { url: string; title: string } | null = null;

interface HistoryItem {
  url: string;
  title: string;
  timestamp: number;
}

// Load/save history
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

// Fetch page title from URL
async function fetchTitle(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Raspcast/1.0)",
      },
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
    const domain = new URL(url).hostname.replace("www.", "");
    return domain;
  } catch {
    return url.slice(0, 50);
  }
}

// Auth middleware
const requireAuth = async (c: any, next: any) => {
  const token = getCookie(c, "auth");
  if (token !== PIN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

// Static files
app.use("/*", serveStatic({ root: "./public" }));

// Auth endpoint
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

// Send command to mpv (fire and forget)
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

// Get property from mpv with response
async function mpvGetProperty(property: string): Promise<any> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 500);
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
          socket.write(
            JSON.stringify({ command: ["get_property", property] }) + "\n"
          );
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

// Play URL
app.post("/api/play", requireAuth, async (c) => {
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: "url required" }, 400);
  }

  if (mpvProcess) {
    mpvProcess.kill();
    mpvProcess = null;
    try {
      await unlink(MPV_SOCKET);
    } catch {}
  }

  const titlePromise = fetchTitle(url);

  mpvProcess = spawn({
    cmd: [
      "mpv",
      "--fullscreen",
      "--input-ipc-server=" + MPV_SOCKET,
      "--ytdl",
      "--volume=100",
      url,
    ],
    stdout: "ignore",
    stderr: "ignore",
  });

  const title = await titlePromise;
  currentMedia = { url, title };
  await addToHistory(url, title);

  mpvProcess.exited.then(() => {
    mpvProcess = null;
    currentMedia = null;
  });

  return c.json({ ok: true, url, title });
});

// Pause/resume toggle
app.post("/api/pause", requireAuth, async (c) => {
  const ok = await mpvCommand(["cycle", "pause"]);
  return c.json({ ok });
});

// Stop playback
app.post("/api/stop", requireAuth, async (c) => {
  await mpvCommand(["quit"]);
  if (mpvProcess) {
    mpvProcess.kill();
    mpvProcess = null;
  }
  currentMedia = null;
  return c.json({ ok: true });
});

// Seek relative (seconds)
app.post("/api/seek", requireAuth, async (c) => {
  const { seconds } = await c.req.json();
  const secs = Number(seconds) || 10;
  const ok = await mpvCommand(["seek", secs, "relative"]);
  return c.json({ ok });
});

// Seek absolute (percentage 0-100)
app.post("/api/seek-to", requireAuth, async (c) => {
  const { percent } = await c.req.json();
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const ok = await mpvCommand(["seek", pct, "absolute-percent"]);
  return c.json({ ok });
});

// Set volume (0-150)
app.post("/api/volume", requireAuth, async (c) => {
  const { volume } = await c.req.json();
  const vol = Math.max(0, Math.min(150, Number(volume) || 100));
  const ok = await mpvCommand(["set_property", "volume", vol]);
  return c.json({ ok, volume: vol });
});

// Get playback status with position
app.get("/api/status", requireAuth, async (c) => {
  if (!mpvProcess) {
    return c.json({ playing: false, current: null });
  }

  const [position, duration, paused, volume] = await Promise.all([
    mpvGetProperty("time-pos"),
    mpvGetProperty("duration"),
    mpvGetProperty("pause"),
    mpvGetProperty("volume"),
  ]);

  return c.json({
    playing: true,
    paused: paused === true,
    current: currentMedia,
    position: position ?? 0,
    duration: duration ?? 0,
    volume: volume ?? 100,
  });
});

// Get history
app.get("/api/history", requireAuth, async (c) => {
  const history = await loadHistory();
  return c.json(history);
});

// Clear history
app.delete("/api/history", requireAuth, async (c) => {
  await saveHistory([]);
  return c.json({ ok: true });
});

console.log(`Raspcast running on http://0.0.0.0:${PORT}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
