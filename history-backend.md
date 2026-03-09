# History Backend Plan

## Goal

Add a file-backed history of the 20 most recently played media items, including enough state to resume playback from the last known position.

The backend should support:

1. Persisting the last 20 played items to disk.
2. Updating resume position while playback is active.
3. Exposing history to the frontend with an authenticated endpoint.
4. Starting playback from a saved position when requested.

## Current Backend Shape

### Playback flow

- [server/ws/client.go](/Users/rup/projects/raspcast/server/ws/client.go#L75) dispatches websocket `play` messages.
- [server/ws/hub.go](/Users/rup/projects/raspcast/server/ws/hub.go#L17) defines the player interface used by websocket clients.
- [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go#L107) exposes `Play(url string) error`.
- [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go#L189) forwards play requests to mpv.
- [server/mpv/controller.go](/Users/rup/projects/raspcast/server/mpv/controller.go#L103) starts or replaces playback in mpv.
- [server/mpv/launcher.go](/Users/rup/projects/raspcast/server/mpv/launcher.go#L9) launches the initial mpv process.

### Current observable state

- [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go#L47) already tracks:
  - `URL`
  - `Position`
  - `Duration`
  - `Title`
- [server/mpv/controller.go](/Users/rup/projects/raspcast/server/mpv/controller.go#L68) already observes:
  - `media-title`
  - `time-pos`
  - `duration`

That means the backend already has the raw data needed for resume history, but it does not persist any of it.

### Current HTTP surface

- [server/main.go](/Users/rup/projects/raspcast/server/main.go#L27) only registers `/auth`, `/ws`, and static file serving.
- There is no REST endpoint for history yet.

## Recommended Data Model

Add a dedicated `server/history` package.

Reason:
- history persistence is a separate concern from live player state
- `GET /history` will depend on it directly
- keeping file IO out of `player` keeps the boundaries cleaner

Suggested persisted struct:

```go
type Item struct {
    URL            string    `json:"url"`
    Title          string    `json:"title,omitempty"`
    ResumePosition float64   `json:"resumePosition"`
    Duration       float64   `json:"duration,omitempty"`
    LastPlayedAt   time.Time `json:"lastPlayedAt"`
}
```

Notes:
- `ResumePosition` should be seconds, matching mpv `time-pos`.
- `LastPlayedAt` is clearer than `UpdatedAt`; this list is about recency of playback.
- Keep the identity keyed by `URL` unless you already know you need something stronger.
- Do not persist `Completed`; derive it from `resumePosition` and `duration` when serving the API.

## Storage Format

Use a single JSON file on disk containing an array of history items, newest first.

Suggested path:
- `/var/lib/raspcast/history.json`, or
- configurable via env, e.g. `HISTORY_FILE`

Suggested behavior:
- If the file is missing, start with an empty list.
- On every write, write to a temp file and rename it atomically.
- Keep only 20 items after each update.

Reason:
- The volume is tiny.
- Atomic replace is enough here.
- This avoids bringing in a database for a trivial persistence need.

## New History Store

Create a dedicated file-backed store in `server/history/store.go`.

Suggested interface:

```go
type Store interface {
    Snapshot() []Item
    Upsert(item Item) error
}
```

Implementation details:
- Load the file once at startup.
- Keep data in memory behind a mutex.
- Rewrite the full JSON file on updates.
- Deduplicate by URL.
- Move the updated item to the front.
- Truncate to 20 items.
- `Snapshot` should return a defensive copy, not the backing slice.

## When To Write History

The cleanest place is inside `player`, because that is where all relevant state already converges.

### On play start

When [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go#L189) accepts a new play request:

- If another item is currently streaming, flush its latest in-memory history state before replacing it.
- Create or move a `HistoryItem` for the URL to the front.
- Seed it with:
  - `URL`
  - saved or requested start position
  - zero or last-known title/duration until mpv reports them

### On property updates

When [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go#L223) receives:

- `time-pos`
  - update the current item's `Position`
- `duration`
  - update `Duration`
- `media-title`
  - update `Title`

Do not write the file on every single `time-pos` event. That would be too chatty.

### Debounce persistence

Add a debounce or checkpoint policy:

- persist at most every 5-10 seconds while playing, and
- persist immediately on stop or on media replacement

Reason:
- `time-pos` can update frequently.
- Resume accuracy does not need sub-second precision.

### On stop / file replacement

When playback stops or a new URL replaces the current one:

- flush the latest in-memory resume position to disk immediately

This matters because:
- [server/mpv/controller.go](/Users/rup/projects/raspcast/server/mpv/controller.go#L123) can replace the current file with `loadfile`, so the previous item should be saved before it is displaced.

## Player API Changes

`Play` needs a resume/start position.

### Update the player interface

Change:

- [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go#L107)
- [server/ws/hub.go](/Users/rup/projects/raspcast/server/ws/hub.go#L17)
- [server/ws/client_test.go](/Users/rup/projects/raspcast/server/ws/client_test.go)

From:

```go
Play(url string) error
```

To something like:

```go
Play(url string, startSeconds float64) error
```

or:

```go
type PlayRequest struct {
    URL          string
    StartSeconds float64
}
```

Recommendation:
- Use a request struct. Resume will likely grow more knobs later.

## Websocket Protocol Changes

Update [server/ws/protocol.go](/Users/rup/projects/raspcast/server/ws/protocol.go#L9) so `play` can include a start position.

Suggested new field:

```go
StartSeconds float64 `json:"startSeconds,omitempty"`
```

Then update [server/ws/client.go](/Users/rup/projects/raspcast/server/ws/client.go#L75) to pass that through to `Player.Play`.

Behavior:
- If `startSeconds <= 0`, start from the beginning.
- If `startSeconds > 0`, ask mpv to start at that position.

## mpv Resume Strategy

Use mpv's `start` option, not a post-load `seek`, as the primary mechanism.

Official mpv docs:
- `--start=<relative time>` seeks to a given time position. Source: https://mpv.io/manual/stable/#playback-control
- `loadfile <url> [<flags> [<index> [<options>]]]` accepts per-file options as the 4th argument; with mpv 0.38+, the 3rd argument must be `-1` to use the 4th argument. Source: https://mpv.io/manual/stable/#command-interface

### Initial mpv launch

Update [server/mpv/launcher.go](/Users/rup/projects/raspcast/server/mpv/launcher.go#L9) and [server/mpv/launcher.go](/Users/rup/projects/raspcast/server/mpv/launcher.go#L20):

- pass `startSeconds` into `Launch`
- append `--start=<seconds>` only when `startSeconds > 0`

Suggested shape:

```go
Launch(url, socketPath string, startSeconds float64) (Process, error)
```

### Replacing media in an already running mpv

Update [server/mpv/controller.go](/Users/rup/projects/raspcast/server/mpv/controller.go#L117):

- if `startSeconds > 0`, send:

```go
[]any{"loadfile", url, "replace", -1, fmt.Sprintf("start=%f", startSeconds)}
```

- otherwise keep:

```go
[]any{"loadfile", url, "replace"}
```

Reason:
- This is cleaner than loading from 0 and issuing a later `seek`.
- It avoids races around file load timing.

### Fallback option

If the per-file `start=` option proves awkward in JSON IPC formatting, fallback is:

1. start/load the file normally
2. on `file-loaded`, send:

```go
[]any{"seek", startSeconds, "absolute"}
```

This is acceptable as a fallback, but the primary design should use `start`.

## Current Status

The following pieces already exist:

- [server/history/store.go](/Users/rup/projects/raspcast/server/history/store.go)
  - `Item`
  - `Store`
  - `FileStore`
  - atomic JSON persistence
- [server/history/handler.go](/Users/rup/projects/raspcast/server/history/handler.go)
  - authenticated `GET /history`
  - JSON response shape:

```json
{
  "items": [
    {
      "url": "https://example.com/video",
      "title": "Example Video",
      "resumePosition": 532.4,
      "duration": 1800,
      "lastPlayedAt": "2026-03-09T18:00:00Z"
    }
  ]
}
```

- [server/main.go](/Users/rup/projects/raspcast/server/main.go)
  - optional history store initialization via `HISTORY_STORE`
  - graceful `503` when history is unavailable

What is still missing:

- nothing writes into the history store yet
- `GET /history` works, but it returns an empty list unless the file was pre-populated

## What To Do Next

Implement this in 2 phases.

### Phase 1: Make history populate

Goal:
- make `GET /history` return real recent items
- do not implement resume playback yet
- do not add websocket history broadcasts yet

Recommended scope:

1. Inject a history dependency into `player`.
2. Write a history item when playback becomes active.
3. Update that item when title and duration arrive.
4. Optionally keep `time-pos` only in memory for now.

This is enough for:
- shared recent-items list
- persistence across restarts
- frontend history rendering

### Phase 2: Add resume support

Goal:
- persist resume position while playback is active
- allow `play` to start from a saved offset

This phase should come later, after Phase 1 is working.

## Phase 1 Walkthrough

### 1. Narrow the dependency

Do not make `player` depend on `*history.FileStore`.

Add a narrow interface in [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go):

```go
type HistoryStore interface {
    Upsert(item history.Item) error
}
```

Then update `Player` to keep an optional history dependency:

```go
type Player struct {
    ...
    history HistoryStore
}
```

Reason:
- `player` should depend on behavior, not file-backed implementation details
- history is optional, so `nil` should remain valid

### 2. Inject it from `main`

Update [server/main.go](/Users/rup/projects/raspcast/server/main.go):

```go
player := player.New(mpvCtrl, mpvCtrl.Events, historyStore)
```

That means `player.New(...)` needs one more parameter.

Keep the optional behavior:
- if history store failed to initialize, `historyStore` stays `nil`
- `player` should simply skip history writes in that case

### 3. Add a helper inside `player`

Inside [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go), add one private helper that writes the current state into history.

Suggested shape:

```go
func (p *Player) upsertHistory() {
    if p.history == nil || p.state.URL == "" {
        return
    }

    item := history.Item{
        URL:            p.state.URL,
        Title:          p.state.Title,
        ResumePosition: p.state.Position,
        Duration:       p.state.Duration,
        LastPlayedAt:   time.Now().UTC(),
    }

    if err := p.history.Upsert(item); err != nil {
        slog.Error("upsert history", "err", err)
    }
}
```

Reason:
- keeps history-writing logic in one place
- avoids repeating struct construction in multiple event branches

### 4. Write on `mpv.Ready`

In [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go), the first useful hook is the `mpv.Ready` event.

Today it already does:
- set `Streaming`
- set `URL`
- emit the websocket `active` event

After that, call:

```go
p.upsertHistory()
```

Why this is the right first hook:
- playback is now actually active
- you know the URL for sure
- if playback fails before `Ready`, you do not create a bogus history entry

### 5. Update when metadata arrives

Still in [server/player/player.go](/Users/rup/projects/raspcast/server/player/player.go), after these property updates:

- `media-title`
- `duration`

call:

```go
p.upsertHistory()
```

Why:
- title often arrives after playback starts
- duration may also arrive later
- store `Upsert` already deduplicates by URL, so this simply enriches the existing top item

### 6. Leave position persistence minimal for now

For Phase 1, do not write to disk on every `time-pos` event.

That means:
- keep updating `p.state.Position` in memory as you already do
- do not call `upsertHistory()` from `time-pos` yet

Reason:
- writing the JSON file on every time update is unnecessary for the first milestone
- the first frontend need is “recent items exist”, not accurate resume checkpoints

If you want one simple improvement before full debounce logic, you can also flush once on stop:

```go
case mpv.Stopped:
    p.upsertHistory()
    p.state = State{}
```

But only do this if `p.state.URL` is still populated at that point.

## Suggested First Code Changes

In order:

1. Update `player.New(...)` to accept an optional history dependency.
2. Store that dependency on `Player`.
3. Add `upsertHistory()`.
4. Call it from:
   - `mpv.Ready`
   - `media-title`
   - `duration`
5. Pass `historyStore` from `main`.
6. Manually test:
   - start backend with `HISTORY_STORE=/tmp/raspcast-history.json`
   - play one URL
   - call `GET /history`
   - verify the item appears

## What To Skip For Now

Do not implement these yet:

- `play` with `startSeconds`
- debounced `time-pos` checkpoints
- websocket `history` broadcasts
- delete / clear history endpoints
- `completed` derivation in the API
- mpv `start=` wiring

These are all reasonable later, but they are not required to get shared recent history working.

## Phase 2 Checklist

Once Phase 1 works, the next backend steps are:

1. extend `play` request shape to include `startSeconds`
2. update `player.Play(...)`
3. update `ws` protocol and dispatch
4. add debounced checkpoint persistence from `time-pos`
5. optionally add websocket `history` broadcasts for live multi-client sync

At that point the store data you already have:

```go
ResumePosition float64
Duration       float64
```

becomes useful for resume playback, not just for display.
