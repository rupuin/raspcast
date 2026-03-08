# Controller Actor Refactor

## Summary

Refactor `mpv.Controller` into a single-owner actor, following the same shape as `player.Player`: one `run()` loop, one action queue, and small handler methods. Use `context.CancelFunc` plus a `workerDone` channel to stop and replace the socket worker cleanly, instead of generation/session fields.

Keep the external controller behavior the same: `Start(url) error`, `Send([]any)`, and `Stop()` remain; `Ready`, `Property`, and `Stopped` events still drive `player.Player`. The refactor is internal and ownership-focused.

## Implementation Changes

### Controller shape

- Keep mutable runtime state on `Controller`, but make it actor-owned only:
  - `process Process`
  - `socket *ipc.Socket`
  - `workerOut <-chan Event`
  - `socketReady <-chan *ipc.Socket`
  - `workerDone <-chan struct{}`
  - `cancelWorker context.CancelFunc`
- Remove `sync.Mutex`; actor ownership replaces locking.
- Change public event exposure to read-only:
  - keep `Events` as the public stream used by `main.go`
  - back it with an internal writable `events chan Event`
  - set `Events <-chan Event` and only send via `events`
- Keep `actions chan action` as the public command queue.
- Delete the recursive `stop()` helper entirely.

### Run loop and handlers

Reshape `run()` to match `player.Player`:

- `run()` only multiplexes inputs and delegates:
  - `case action := <-c.actions` -> `c.handleAction(action)`
  - `case socket := <-c.socketReady` -> `c.handleSocketReady(socket)`
  - `case event := <-c.workerOut` -> `c.handleWorkerEvent(event)`
- Add small handler methods:
  - `handleAction(action)`
  - `handleStart(action)`
  - `handleSend(action)`
  - `handleStop()`
  - `handleSocketReady(socket *ipc.Socket)`
  - `handleWorkerEvent(event Event)`
  - `startWorker()`
  - `stopWorker()`
  - `stopProcess()`
  - `emit(event Event)`
  - `loadFile(url string) error`
- Keep handlers narrow:
  - `handleStart` decides between `loadfile` on an existing socket vs launching mpv and starting a worker.
  - `handleSend` only sends commands when `socket != nil`.
  - `handleStop` is the single explicit stop path: cancel worker, wait for worker exit, disconnect socket, kill/wait process, emit one `Stopped`.
  - `handleWorkerEvent` handles `Ready`, `Property`, and unexpected `Stopped` from the worker.

### Worker and context strategy

Split the current `connectAndConsume` into two focused helpers:

- `connectSocket(ctx context.Context) (*ipc.Socket, error)`
  - waits for the mpv IPC socket using `waitForSocket`
  - owns only the connection phase
- `forwardSocketEvents(ctx context.Context, socket *ipc.Socket, out chan<- Event)`
  - reads mpv messages from the connected socket
  - parses them into controller `Event` values
  - forwards them to the actor-facing worker output

Use a thin coordinator goroutine to wire those two together:

- `runWorker(ctx, socketReady, workerOut, workerDone)`
  - calls `connectSocket`
  - sends the connected socket on `socketReady`
  - calls `forwardSocketEvents`
  - closes `workerDone` on exit

Use context only for worker lifetime and cancellation, not as a public API change.

- `runWorker(ctx, socketReady, workerOut, workerDone)` must:
  - create a timeout child context for `connectSocket`
  - send the connected socket back on `socketReady`
  - call `forwardSocketEvents`
  - on unexpected socket close, forward `Event{Kind: Stopped}`
  - on `ctx.Done()`, exit silently without sending `Stopped`
- Every send from the worker must be context-aware:
  - `select { case out <- value: case <-ctx.Done(): return }`
  - this prevents blocked sends after stop/restart
- `stopWorker()` must:
  - call `cancelWorker()`
  - wait on `<-workerDone`
  - nil out `cancelWorker`, `workerOut`, `socketReady`, and `workerDone`
- This synchronous stop-and-wait handoff is what removes the need for generations/sessions.

### Event ownership

Enforce one rule throughout the refactor: only the actor writes to the public `Events` stream.

- `runWorker` and `forwardSocketEvents` must never send to `c.Events`
- `runWorker` and `connectSocket` must never mutate `c.socket` or `c.process`
- The actor is the only place that:
  - stores the socket
  - sends mpv commands
  - emits `Ready` / `Property` / `Stopped`

### Parsing and subscriptions

Split parsing into small focused helpers:

- Replace `consume` with `forwardSocketEvents`
- Add a small parser helper:
  - `parseEvent(msg map[string]any) (Event, bool)`
  - `"file-loaded"` -> `Event{Kind: Ready}`
  - `"property-change"` -> `Event{Kind: Property, Name: ..., Value: ...}`
  - everything else is ignored
- Keep `subscribeToSocket(socket)` as a separate helper, but call it from `handleSocketReady` so subscription stays actor-owned.

## API / Interface Decisions

- Keep `NewController(launcher, socketPath)` unchanged.
- Keep `Start(url) error`, `Send(cmd []any)`, and `Stop()` unchanged.
- Do not add public context parameters in this refactor.
- Do not add generation/session fields or extra internal message structs.
- Do not add a public `Shutdown()` method in this refactor.
- Keep `main.go` behavior unchanged; it should still pass the controller event stream into `player.New`.

## Test Plan

Update and extend `mpv/controller_test.go` to validate actor ownership and cancellation behavior:

- Existing behavior still passes:
  - no `Ready` before `file-loaded`
  - second `Start` while running sends `loadfile` and does not relaunch
  - property events are forwarded
  - socket close emits `Stopped`
  - explicit `Stop()` emits `Stopped`
- Add cancellation/ownership cases:
  - `Stop()` during startup cancels the worker and does not deadlock
  - `Stop()` emits exactly one `Stopped`
  - unexpected socket close emits exactly one `Stopped`
  - restarting after a stop does not leak the old worker or reuse stale channels
  - worker cancellation does not emit a spurious `Stopped`
- Keep `player/player_test.go` unchanged unless the `Events` field type change requires compile-only updates.

## Assumptions

- The controller refactor is internal; player semantics should not change.
- The actor will be the only runtime owner of `process`, `socket`, and public event emission.
- One active socket worker at a time is the intended model.
- Context is used for worker cancellation and handoff only; public controller methods remain simple and match the current style of `player.Player`.
