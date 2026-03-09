# Subtitles Backend Plan

## Goal

Add subtitle support to the Go backend so clients can:

1. See what subtitle tracks exist for the current media.
2. Toggle subtitles on or off.
3. Select a specific subtitle track.
4. Add external subtitles at runtime from an HTTP URL.
5. Remove externally added subtitles.

This should build on the existing mpv IPC integration in `server/mpv` and the websocket control path in `server/ws`.

## mpv Capabilities To Use

- `track-list` property: discover embedded and external subtitle tracks.
- `sub-visibility` property: track whether subtitles are visible.
- `set_property sid <id>`: select a subtitle track.
- `set_property sid no`: disable subtitle selection.
- `sub-add <url> [select]`: add subtitles during playback from a URL.
- `sub-remove <id>`: remove an external subtitle track.

## Existing Code Hooks

- `server/mpv/controller.go`
  - Already observes `track-list` and `sub-visibility`.
  - Already exposes a generic `Send(cmd []any)` path for mpv IPC commands.
- `server/player/player.go`
  - Has `Subtitles` event kind already defined.
  - Currently ignores `track-list` and `sub-visibility` updates.
- `server/ws/protocol.go`
  - Needs subtitle-related message fields.
- `server/ws/client.go`
  - Needs subtitle message dispatch cases.

## Implementation Plan

### 1. Add subtitle models to player state

Update `server/player/player.go`:

- Add a `SubtitleTrack` type with fields taken from mpv `track-list`, likely:
  - `ID`
  - `Title`
  - `Lang`
  - `External`
  - `Selected`
- Extend `State` with:
  - `SubtitleVisible bool`
  - `SubtitleTracks []SubtitleTrack`

Reason:
- Snapshot responses should contain enough subtitle state for the client to render controls immediately.

### 2. Parse subtitle-related mpv properties

Update `server/player/player.go` property handling:

- Parse `track-list`
  - Filter to tracks where `type == "sub"`.
  - Convert them into `SubtitleTrack`.
  - Store them in player state.
  - Emit a `Subtitles` event.
- Parse `sub-visibility`
  - Store it in player state.
  - Emit a `Subtitles` event, or add a dedicated event if that reads cleaner.

Reason:
- The mpv controller already subscribes to these properties, so the main missing work is turning them into application state.

### 3. Add player actions for subtitles

Update `server/player/player.go`:

- Add action kinds:
  - `ActionSubtitleToggle`
  - `ActionSubtitleSelect`
  - `ActionSubtitleAdd`
  - `ActionSubtitleRemove`
- Add corresponding player methods:
  - `SubtitleToggle(visible bool)` or `SubtitleToggle()`
  - `SubtitleSelect(id float64 or int)`
  - `SubtitleAdd(url string)`
  - `SubtitleRemove(id float64 or int)`

Map them to mpv commands:

- Toggle visibility:
  - `[]any{"set_property", "sub-visibility", true}`
  - `[]any{"set_property", "sub-visibility", false}`
- Select track:
  - `[]any{"set_property", "sid", id}`
- Disable all subtitles:
  - `[]any{"set_property", "sid", "no"}`
- Add external subtitles:
  - `[]any{"sub-add", url, "select"}`
- Remove external subtitles:
  - `[]any{"sub-remove", id}`

Reason:
- Keep subtitle control logic in `player`, not in websocket handlers.

### 4. Extend websocket protocol

Update `server/ws/protocol.go`:

- Extend `ClientMessage` with subtitle fields:
  - `TrackID`
  - `Visible`
- Reuse existing `URL` for subtitle URLs.

Add message types:

- `subtitle_toggle`
- `subtitle_select`
- `subtitle_add`
- `subtitle_remove`

Reason:
- The client needs explicit verbs rather than overloading generic player actions.

### 5. Dispatch subtitle websocket commands

Update `server/ws/client.go`:

- Add `switch` cases for:
  - `subtitle_toggle`
  - `subtitle_select`
  - `subtitle_add`
  - `subtitle_remove`
- Call the new player methods from those cases.
- Validate obvious bad input:
  - empty URL for `subtitle_add`
  - missing or invalid track id for select/remove

Reason:
- Keep request validation at the websocket boundary and mpv command generation in `player`.

### 6. Define event payload shape

Pick one server event contract for subtitle updates.

Recommended:
- Emit `type: "subtitles"` with a payload like:
  - `visible`
  - `tracks`

Example shape:

```json
{
  "type": "subtitles",
  "value": {
    "visible": true,
    "tracks": [
      {
        "id": 2,
        "title": "English",
        "lang": "en",
        "external": false,
        "selected": true
      }
    ]
  }
}
```

Reason:
- One payload is simpler for the frontend than splitting track changes and visibility changes across separate event types.

### 7. Handle runtime behavior carefully

Expected behavior rules:

- Embedded subtitle tracks:
  - Can be selected or disabled.
  - Cannot be removed.
- External subtitle tracks:
  - Can be added with `sub-add`.
  - Can be removed with `sub-remove`.
- When subtitles are added at runtime:
  - mpv should update `track-list`.
  - Backend should emit a fresh `subtitles` event from the property observer path.

Reason:
- The source of truth should remain mpv property updates, not optimistic local state mutation.

### 8. Add tests

Add tests in `server/player` and `server/ws` for:

- Parsing `track-list` into subtitle state.
- Handling `sub-visibility`.
- Sending correct mpv commands for:
  - toggle on/off
  - select track
  - disable subtitles
  - add subtitle URL
  - remove subtitle track
- Websocket dispatch for the new subtitle message types.

Reason:
- Most of this work is command mapping and state translation, which is easy to regress without tests.

## Recommended Scope For First Pass

Implement only this in the first patch:

1. Subtitle state in player snapshot.
2. `track-list` parsing.
3. `sub-visibility` parsing.
4. `subtitle_toggle`.
5. `subtitle_select`.
6. `subtitle_add`.
7. `subtitle_remove`.

Skip for now:

- secondary subtitle track support
- subtitle delay controls
- subtitle upload pipeline
- filesystem subtitle loading

## Risks / Decisions

- `sub-add` accepts URLs, so the backend will make mpv fetch remote resources. Decide whether any URL is acceptable or whether you want to restrict hosts/schemes.
- mpv track ids are numeric, but websocket JSON numbers arrive as `float64` in Go unless normalized. Decide whether to store IDs as `int` in state and convert at the boundary.
- `sub-remove` should probably reject non-external tracks defensively if the client sends an embedded track id.

## Deliverable

After implementation, the backend should support this flow:

1. Play media.
2. Receive subtitle track list via snapshot/event.
3. Toggle subtitles off and on.
4. Select an embedded subtitle track.
5. Add subtitles from an HTTP URL while media is playing.
6. See the new external subtitle track appear in the track list.
7. Remove that external subtitle track.
