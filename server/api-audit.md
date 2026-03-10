# API Audit

Audit of Go server internals focused on clarity, idiomatic patterns, and lifecycle management.

## Overview

The codebase has a clean layered architecture: `ipc.Socket → mpv.runtime → mpv.Controller → player.Player → ws.Hub`. Each layer adds meaning on top of the previous one. The design is generally good but has accumulated some inconsistencies that make the lifecycle hard to follow and `main` harder to shrink.

The biggest recurring issue is **goroutine lifecycle ownership**. Almost every type starts goroutines but few provide a clean way to stop them. This is what makes shutdown messy and `main` responsible for knowing internal details.

---

## 1. ipc.Socket

### Current API

```go
func NewSocket(path string) (*Socket, error)
func (s *Socket) Send(payload any) error
func (s *Socket) Disconnect()

// Public fields used as API:
s.Messages  chan map[string]any
s.Done      chan struct{}
```

### Issues

**Public channel fields as API.** `Messages` and `Done` are exported struct fields. Callers can write to `Messages` or close `Done` from outside — the ownership contract is implicit. Idiomatic Go returns read-only channels from methods.

**`readLoop` blocks forever if nobody reads `Messages`.** Line 66 does `s.Messages <- msg` with no select. If the consumer is gone (e.g. controller stopped), the goroutine blocks forever and the underlying `net.Conn` stays open.

**Constructor starts goroutine.** `NewSocket` connects and immediately starts `readLoop`. The caller gets no say in when reading begins. This is fine for simple cases but makes testing and lifecycle coordination harder.

### Suggestions

Return read-only channels via methods instead of public fields:

```go
func (s *Socket) Messages() <-chan map[string]any
func (s *Socket) Done() <-chan struct{}
```

This prevents external writes and makes the ownership clear: Socket writes, everyone else reads.

For the blocking `readLoop`, a context-aware send would prevent the goroutine leak:

```go
select {
case s.messages <- msg:
case <-s.done:
    return
}
```

Here `done` is closed by `Disconnect()`, so when nobody cares about messages the goroutine exits.

---

## 2. mpv.runtime

### Current API

All methods are unexported (package-private). This is fine — runtime is an implementation detail of Controller.

```go
func newRuntime(process Process) *runtime
func (r *runtime) connect(ctx context.Context, socketPath string) error
func (r *runtime) command(cmd []any) error
func (r *runtime) stop(ctx context.Context) (*os.ProcessState, error)
func (r *runtime) messages() <-chan map[string]any
func (r *runtime) done() <-chan struct{}
func (r *runtime) hasSocket() bool
```

### Issues

**`messages()` and `done()` return nil channels when socket is nil.** A nil channel blocks forever in a select — this is valid Go but it's a footgun. The caller (`runWorker`) has to know that these channels are only safe to use after `connect()` succeeds. There's no compile-time or runtime guard for this.

**`connect()` polls in a loop with 100ms sleeps.** This is fine practically but the retry loop is the only place in the codebase that uses context properly. Other methods ignore context entirely (e.g. `command`, `disconnect`).

**`stop()` returns `*os.ProcessState` but nobody uses it.** Both `handleStop` and any future caller ignore the process state. The return value adds noise.

### Suggestions

`stop()` can return just `error`. The process state is never inspected:

```go
func (r *runtime) stop(ctx context.Context) error
```

Consider whether `connect` should be part of `newRuntime` — the runtime is useless until connected, so having it exist in a half-initialized state (process but no socket) adds complexity to every method that checks `hasSocket()`.

---

## 3. mpv.Controller

### Current API

```go
func NewController(launcher Launcher, socketPath string) *Controller
func (c *Controller) Start(url string) error   // sync (reply channel)
func (c *Controller) Send(cmd []any)            // async (fire-and-forget)
func (c *Controller) Stop()                     // sync (reply channel)

c.Events  <-chan Event  // public read-only channel
```

### Issues

**`run()` is an infinite loop with no exit path.** The controller goroutine started in `NewController` runs forever. Even after `Stop()`, the goroutine sits in the select waiting for more actions that will never come. This is the biggest lifecycle gap — you can stop mpv but you can never stop the controller itself.

**Private `events` field shadows public `Events`.** The struct has both `Events <-chan Event` (public, read-only) and `events chan Event` (private, writable). They point to the same underlying channel. This works but is confusing when reading the code — `c.events <- Event{...}` looks like it writes to a private channel, but it actually writes to the public one.

**`Send()` is fire-and-forget while `Start()` and `Stop()` block.** Three public methods, two different calling conventions. `Send` gives no feedback — you don't know if the command was received, processed, or errored. This is fine for property changes but callers have to know which methods block and which don't.

**Constructor starts the goroutine.** Same pattern as Socket — no lifecycle control for the caller. The controller is "running" the moment it's created, before anyone reads from `Events`.

**`handleWorkerDone` uses `cancelWorker != nil` as an "unexpected exit" flag.** After `handleStop` runs, it sets `cancelWorker = nil`, so if the worker exits after stop, `handleWorkerDone` sees `cancelWorker == nil` and treats it as expected. But if the worker crashes before `handleStop` runs, `cancelWorker != nil` and it emits a `Stopped` event. This implicit signaling via nil/non-nil is fragile — a bool flag like `stoppingWorker` would be clearer.

### Suggestions

**Add a way to shut down the controller goroutine.** Either accept a context in the constructor or add a `Close()` method that closes the actions channel or a done channel. Without this, main can't fully clean up.

```go
func NewController(ctx context.Context, launcher Launcher, socketPath string) *Controller
```

When `ctx` is canceled, `run()` exits. This also gives main a single cancellation mechanism that flows down through the whole stack.

**Rename the private channel to avoid shadowing:**

```go
type Controller struct {
    Events  <-chan Event
    eventCh chan Event   // or just inline the send calls
    ...
}
```

**Consider making the `run()` goroutine startup explicit.** If `NewController` doesn't start the goroutine, you get a clear two-phase lifecycle: create, then start. This matches how `ws.Hub` already works (constructor + explicit `Run()`). Consistency across packages makes the codebase easier to navigate.

---

## 4. player.Player

### Current API

```go
func New(ctrl MpvController, ctrlEvents <-chan mpv.Event) *Player
func (p *Player) Play(url string) error
func (p *Player) Stop()
func (p *Player) Pause()
func (p *Player) Seek(percent float64)
func (p *Player) Skip(seconds float64)
func (p *Player) Volume(val float64)
func (p *Player) Snapshot() State
func (p *Player) Shutdown()

p.Events  chan Event  // public channel
```

### Issues

**`Stop()` vs `Shutdown()` is confusing.** `Stop()` enqueues an action that tells mpv to stop playback. `Shutdown()` closes the done channel to exit the player goroutine. These are both "stop the player" to an outside reader. The naming doesn't communicate that `Stop` = stop playback and `Shutdown` = tear down the goroutine.

**`Stop()` calls `ctrl.Stop()` but main also calls `ctrl.Stop()` directly.** During shutdown, `main.go` calls `mpvCtrl.Stop()` and then `mpvPlayer.Shutdown()`. But `player.Stop()` also calls `ctrl.Stop()`. Who owns the mpv lifecycle? The answer is "both, depending on context" — the player stops mpv during normal playback, main stops mpv during shutdown. This dual ownership is the root of the confusion.

**`Events` is a writable `chan Event`, not `<-chan Event`.** Unlike Controller which exposes a read-only channel, Player exposes a writable channel. Any external code could write to `p.Events`.

**Constructor starts goroutine immediately.** Same pattern as Controller and Socket.

**`ctrlEvents` accepted as a raw channel.** The player takes `<-chan mpv.Event` directly rather than accepting the Controller. This is actually good for testability (you can pass a fake channel), but it means the player's dependency on Controller is split across two parameters: `ctrl MpvController` for commands and `ctrlEvents` for events. They must come from the same Controller instance but nothing enforces that.

### Suggestions

**Rename to make the two stop paths clear.** Options:
- Rename `Stop()` to `StopPlayback()` — though this is verbose
- Fold shutdown into `Stop()` — if the player goroutine should die when playback stops for good, combine them
- Keep `Shutdown()` but consider whether `Stop()` should exist at all on Player. If the only external caller of `Stop()` is the ws dispatch, and shutdown is handled by main, the two paths are clear enough with better docs

**Make `Events` read-only:**

```go
type Player struct {
    Events  <-chan Event
    eventCh chan Event
    ...
}
```

**Consider passing Controller directly** rather than `(ctrl, ctrl.Events)`:

```go
func New(ctrl *mpv.Controller) *Player
```

The player can read `ctrl.Events` internally. This removes the possibility of passing mismatched ctrl + events.

---

## 5. ws.Hub

### Current API

```go
func NewHub(p Player, events <-chan player.Event) *Hub
func (h *Hub) Run()
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request)
```

### Issues

**`Run()` never terminates.** No context, no done channel, no way to stop it. The goroutine runs until the process exits. This means main can't shut down the Hub cleanly, and any connected WebSocket clients won't get a clean close frame on shutdown.

**Same split-dependency as Player.** Hub takes `(player, events)` separately — same issue as Player taking `(ctrl, ctrlEvents)`. The events must come from the same Player instance.

**`removeClient` closes `client.send` while `writePump` may be ranging over it.** If `readPump` triggers unregister, Hub calls `removeClient` which closes `send`. This is actually safe because `writePump` ranges over the channel and will exit when it's closed. But `removeClient` also calls `client.conn.Close()`, while `readPump`'s defer also calls `client.conn.Close()`. Double-close on the conn — gorilla/websocket handles this safely but it's messy.

### Suggestions

**Accept context to make `Run` stoppable:**

```go
func (h *Hub) Run(ctx context.Context)
```

Add `case <-ctx.Done(): return` to the select in `Run()`. On exit, close all client connections and send channels. This gives main a clean way to shut down the Hub.

**Pass Player directly** instead of `(player, events)`:

```go
func NewHub(p *player.Player) *Hub
```

---

## 6. main.go

### Current shape (after graceful shutdown changes)

```go
func main() {
    // env + config (3 lines)
    // construct mpv stack (3 lines)
    // construct ws hub (1 line)
    // construct history (8 lines)
    // construct auth (2 lines)
    // register routes (5 lines)
    // start hub goroutine (1 line)
    // create http.Server (3 lines)
    // signal handling (2 lines)
    // start server goroutine (5 lines)
    // wait for signal/error (5 lines)
    // shutdown sequence (10 lines)
}
```

~48 lines total. Not huge, but the shutdown logic is the messy part.

### What makes main hard to shrink

Main is bloated not because it does too much setup, but because **it has to know the shutdown order of internal components.** It calls `mpvCtrl.Stop()`, then `mpvPlayer.Shutdown()`, then `srv.Shutdown()`. This is a consequence of each component having its own lifecycle primitives that don't compose.

If the components used context for lifecycle, main could cancel one context and everything would drain:

```go
ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
defer cancel()
// ... setup ...
<-ctx.Done()
// cancel propagates; each component shuts itself down
```

The shutdown section in main could shrink to near-zero.

### Concrete path to a smaller main

Don't add factories or a "server" struct that wraps everything. Instead:

1. Thread a context through constructors: `NewController(ctx, ...)`, `player.New(ctx, ...)`, `NewHub(ctx, ...)`
2. Each component's `run()` goroutine selects on `ctx.Done()` and cleans up its own resources
3. Main cancels context, then waits for components to finish (via a `sync.WaitGroup` or individual `Done()` channels)
4. The only thing main needs to do explicitly after cancel is `srv.Shutdown()`, because the HTTP server has its own shutdown API

This removes the need for `mpvCtrl.Stop()`, `mpvPlayer.Shutdown()`, and `wsHub` teardown from main. Each component owns its own cleanup.

---

## 7. Cross-cutting patterns

### Goroutine-in-constructor

Three out of four long-lived types start goroutines in their constructor: `NewController`, `player.New`, `NewSocket`. Hub is the exception — it requires an explicit `go hub.Run()`.

This is non-idiomatic in Go. The standard library and most well-regarded Go code separates construction from execution. `http.Server` is a good example: you create it, then call `ListenAndServe`. Even `context.WithCancel` returns the context and cancel separately.

**Recommendation:** Make all types consistent. Either:
- All types require explicit `Run(ctx)` (preferred — matches Hub, matches stdlib)
- Or all types start in constructor (current majority, but harder to test and coordinate)

The explicit `Run(ctx)` approach is better because:
- Caller controls when the goroutine starts
- Context flows naturally
- Testing doesn't need to deal with background goroutines during construction

### Event channel ownership

Every type has its own `Events` channel pattern but the conventions differ:

| Type | Field | Direction | Buffered |
|------|-------|-----------|----------|
| Controller | `Events <-chan Event` | read-only | 16 |
| Player | `Events chan Event` | read-write | 16 |
| Socket | `Messages chan map[string]any` | read-write | 16 |
| Socket | `Done chan struct{}` | read-write | 0 |

**Recommendation:** All event channels exposed to consumers should be `<-chan`. The writable end stays private. This is idiomatic Go (see `context.Done()`, `time.After()`, `signal.NotifyContext()`).

### Naming collisions

- `Kind` is defined in both `mpv` and `player` packages. When both are imported, you need `mpv.Kind` vs `player.Kind`. Not a bug but worth being aware of.
- `Event` is defined in both `mpv` and `player`. Same issue.
- `Stop()` means different things: on Controller it stops the mpv process, on Player it stops playback (which calls Controller.Stop()), in main it's the signal cancel function.

### Error handling

The codebase has three error handling styles:
1. **Sync via reply channel:** `Start()`, `Stop()` — caller blocks and gets error
2. **Fire-and-forget:** `Send()`, `player.Stop()`, `player.Pause()` — no feedback
3. **Logging and dropping:** `readLoop`, `runWorker` — errors logged, not propagated

This is fine but worth documenting. The fire-and-forget methods are intentionally "best effort" — if mpv isn't running, pause/seek/volume are no-ops. That's correct behavior but a new reader might wonder why some methods return errors and others don't.

---

## 8. Summary of recommended changes (priority order)

### High impact, low effort

1. **Make `Events`/`Messages`/`Done` fields read-only (`<-chan`)** across all types
2. **Rename private `events` to `eventCh`** in Controller to avoid shadowing
3. **Accept context in constructors** for Controller, Player, Hub — use it to exit `run()` loops
4. **Drop `*os.ProcessState` return** from `runtime.stop()`

### Medium impact, medium effort

5. **Move goroutine start from constructors to explicit `Run(ctx)` methods** — makes lifecycle explicit, testable, and consistent with Hub
6. **Pass Controller directly to Player** (and Player directly to Hub) instead of split `(obj, obj.Events)` pairs
7. **Add context-aware send in `ipc.Socket.readLoop`** to prevent goroutine leak

### Lower priority

8. **Clarify `Stop()` vs `Shutdown()`** naming on Player — or collapse into one method
9. **Consider whether `Send()` should return error** for consistency (probably not — fire-and-forget is correct for real-time property updates)
10. **Document the intentional fire-and-forget pattern** so new readers understand the design choice

### What NOT to do

- Don't add a `Server` struct in main that wraps everything — that's just moving the wiring, not simplifying it
- Don't add interfaces for Controller or Player in the packages that define them — define interfaces where they're consumed (Go proverb: "accept interfaces, return structs")
- Don't add dependency injection frameworks or config structs — the current direct wiring is readable
- Don't add `Close()` / `Shutdown()` / `Stop()` to every type separately — context cancellation is the idiomatic Go answer for coordinated shutdown
