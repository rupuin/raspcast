import {
  AlertCircle,
  Captions,
  Eye,
  EyeOff,
  FastForward,
  Link2,
  Pause,
  Play,
  Rewind,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type SyntheticEvent,
  type FocusEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import { HistoryList } from '../history/HistoryList'
import { playerCommand } from './commands'
import { initialPlayerState, playerReducer } from './reducer'
import { formatTime } from './utils'
import { PlayerWsClient, getSocketUrl } from './ws'

export function PlayerView() {
  const [state, dispatch] = useReducer(playerReducer, initialPlayerState)
  const [urlInput, setUrlInput] = useState('')
  const [urlExpanded, setUrlExpanded] = useState(true)
  const [loading, setLoading] = useState(false)
  const [showSubPanel, setShowSubPanel] = useState(false)
  const [subtitleUrl, setSubtitleUrl] = useState('')
  const [subtitlesLoaded, setSubtitlesLoaded] = useState(false)
  const [subtitlesVisible, setSubtitlesVisible] = useState(true)
  const clientRef = useRef<PlayerWsClient | null>(null)

  useEffect(() => {
    const client = new PlayerWsClient(getSocketUrl())
    clientRef.current = client

    client.onOpen = () => {
      dispatch({ type: 'connected' })
      client.send(playerCommand.snapshot())
    }

    client.onMessage = (message) => {
      dispatch({ type: 'server_message', message })
      if (
        message.type === 'active' ||
        message.type === 'stopped' ||
        message.type === 'error'
      ) {
        setLoading(false)
      }
    }

    client.onReconnecting = () => {
      dispatch({ type: 'reconnecting' })
    }

    client.onClose = () => {
      dispatch({ type: 'disconnected' })
    }

    client.connect()

    return () => {
      client.disconnect()
      clientRef.current = null
    }
  }, [])

  // Collapse URL bar when active media changes, expand when stopped
  const activeUrl = state.streaming ? state.url : null
  useEffect(() => {
    if (activeUrl) {
      setUrlExpanded(false)
      setLoading(false)
    } else {
      setUrlExpanded(true)
      setLoading(false)
    }
  }, [activeUrl])

  const urlInputRef = useRef<HTMLInputElement>(null)
  const urlFormRef = useRef<HTMLFormElement>(null)

  const handleUrlBlur = (e: FocusEvent) => {
    // Collapse when focus leaves the form entirely (not moving to another element inside it)
    if (
      state.streaming &&
      urlFormRef.current &&
      !urlFormRef.current.contains(e.relatedTarget as Node)
    ) {
      setUrlExpanded(false)
    }
  }

  const playUrl = (url: string) => {
    const trimmed = url.trim()
    if (trimmed) {
      clientRef.current?.send(playerCommand.play(trimmed))
      setUrlExpanded(false)
      setLoading(true)
      urlInputRef.current?.blur()
    }
  }

  const handleSubmitUrl = (e: SyntheticEvent) => {
    e.preventDefault()
    playUrl(urlInput)
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').trim()
    if (pasted) {
      setUrlInput(pasted)
      playUrl(pasted)
    }
  }

  const handlePlayPause = () => {
    if (state.streaming) {
      clientRef.current?.send(playerCommand.pause())
      return
    }

    const url = urlInput.trim() || state.url.trim()
    if (url) clientRef.current?.send(playerCommand.play(url))
  }

  const handleStop = () => {
    clientRef.current?.send(playerCommand.stop())
  }

  const handleSkip = (seconds: number) => {
    clientRef.current?.send(playerCommand.skip(seconds))
  }

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    clientRef.current?.send(playerCommand.seek(Number(e.target.value)))
  }

  const handleVolume = (e: ChangeEvent<HTMLInputElement>) => {
    clientRef.current?.send(playerCommand.volume(Number(e.target.value)))
  }

  // Subtitle handlers (placeholder — will wire to backend)
  const handleLoadSubtitles = (e: SyntheticEvent) => {
    e.preventDefault()
    if (subtitleUrl.trim()) {
      // TODO: send subtitle load command via websocket
      setSubtitlesLoaded(true)
      setSubtitleUrl('')
    }
  }

  const handleRemoveSubtitles = () => {
    // TODO: send subtitle remove command
    setSubtitlesLoaded(false)
    setShowSubPanel(false)
    setSubtitlesVisible(true)
  }

  const seekPct =
    state.duration > 0
      ? Math.min((state.position / state.duration) * 100, 100)
      : 0
  const canPlay = Boolean(urlInput.trim() || state.url.trim())
  const canControl = state.streaming
  const VolumeIcon = state.volume === 0 ? VolumeX : Volume2

  return (
    <main className="min-h-dvh flex items-start justify-center px-4 py-8">
      <div className="w-full max-w-md flex flex-col gap-3">
        {/* ─── Header ─── */}
        <header className="flex items-center justify-between px-1">
          <h1 className="text-base font-semibold tracking-tight text-white">
            raspcast
          </h1>
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full transition-colors ${
                state.connected
                  ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                  : state.reconnecting
                    ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.4)] animate-pulse'
                    : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.4)]'
              }`}
            />
            <span className="text-xs text-slate-500">
              {state.connected ? 'Connected' : state.reconnecting ? 'Connecting…' : 'Offline'}
            </span>
          </div>
        </header>

        {/* ─── URL Bar (morphing pill ↔ input) ─── */}
        <form
          ref={urlFormRef}
          onSubmit={handleSubmitUrl}
          onBlur={handleUrlBlur}
          onClick={
            !urlExpanded
              ? () => {
                  setUrlExpanded(true)
                  requestAnimationFrame(() => {
                    urlInputRef.current?.focus()
                    urlInputRef.current?.select()
                  })
                }
              : undefined
          }
          className={`flex items-center border bg-white/5 backdrop-blur-sm transition-all duration-300 ease-out ${
            urlExpanded
              ? 'gap-3 rounded-2xl px-4 py-3 border-white/8 focus-within:border-rose-500/25'
              : `gap-2 rounded-full px-3 py-2 cursor-pointer hover:bg-white/8 ${
                  loading
                    ? 'border-rose-500/30 glow-loading'
                    : 'border-white/8 hover:border-white/12'
                }`
          }`}
        >
          <Link2
            className={`shrink-0 transition-all duration-300 ${
              urlExpanded ? 'h-4 w-4 text-slate-500' : 'h-3 w-3 text-slate-600'
            }`}
            strokeWidth={1.6}
          />

          {/* Input and URL text share the same space, cross-fading */}
          <div className="relative flex-1 min-w-0">
            <input
              ref={urlInputRef}
              className={`w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600 transition-opacity duration-200 ${
                urlExpanded ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onPaste={handlePaste}
              placeholder="Paste media URL..."
              tabIndex={urlExpanded ? 0 : -1}
            />
            <span
              className={`absolute inset-0 flex items-center text-xs truncate select-none transition-opacity duration-200 ${
                urlExpanded
                  ? 'opacity-0 pointer-events-none'
                  : loading
                    ? 'opacity-100 text-rose-400/70'
                    : 'opacity-100 text-slate-500'
              }`}
            >
              {loading ? 'Loading media...' : state.url || 'No media loaded'}
            </span>
          </div>

          {/* Submit button slides out when collapsed */}
          <button
            type="submit"
            tabIndex={urlExpanded ? 0 : -1}
            disabled={!urlInput.trim()}
            className={`shrink-0 rounded-xl bg-rose-500/15 text-rose-400 transition-all duration-200 ease-out hover:bg-rose-500/25 disabled:opacity-20 disabled:cursor-not-allowed overflow-hidden ${
              urlExpanded
                ? 'max-w-[2.5rem] p-2 opacity-100'
                : 'max-w-0 p-0 opacity-0'
            }`}
          >
            <Play
              className="h-3.5 w-3.5 shrink-0"
              strokeWidth={2.5}
              fill="currentColor"
            />
          </button>
        </form>

        {/* ─── Now Playing Card ─── */}
        <section className="rounded-3xl border border-white/8 bg-white/[0.04] px-5 pt-5 pb-4 backdrop-blur-xl shadow-2xl shadow-black/20">
          {/* Track Info */}
          <div className="min-h-[2.5rem]">
            <h2 className="text-lg font-semibold tracking-tight text-white leading-snug line-clamp-2">
              {state.title || 'Nothing playing'}
            </h2>
            {state.url && (
              <p className="mt-1 text-xs text-slate-500 truncate">
                {state.url}
              </p>
            )}
          </div>

          {/* Status indicator */}
          {state.streaming && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  state.paused ? 'bg-rose-500' : 'bg-emerald-400 animate-pulse'
                }`}
              />
              <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                {state.paused ? 'Paused' : 'Playing'}
              </span>
            </div>
          )}

          {/* Seek Bar */}
          <div className="mt-4">
            <input
              className="seek-range"
              type="range"
              min="0"
              max="100"
              step="1"
              value={seekPct}
              onChange={handleSeek}
              disabled={!canControl}
              style={{
                background: `linear-gradient(to right, rgba(244,63,94,0.7) ${seekPct}%, rgba(255,255,255,0.08) ${seekPct}%)`,
              }}
            />
            <div className="mt-1 flex justify-between">
              <span className="text-[11px] tabular-nums text-slate-500">
                {formatTime(state.position)}
              </span>
              <span className="text-[11px] tabular-nums text-slate-500">
                {formatTime(state.duration)}
              </span>
            </div>
          </div>

          {/* Transport + Volume */}
          <div className="mt-4 flex items-center">
            {/* Transport */}
            <div className="flex flex-1 flex-col items-center gap-1">
              <div className="flex items-center justify-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowSubPanel((v) => !v)}
                  disabled={!canControl}
                  className={`rounded-xl p-2.5 transition disabled:opacity-20 disabled:cursor-not-allowed ${
                    subtitlesLoaded
                      ? 'text-rose-400 hover:bg-rose-500/10'
                      : showSubPanel
                        ? 'text-slate-300 bg-white/8'
                        : 'text-slate-400 hover:text-white hover:bg-white/8'
                  }`}
                >
                  <Captions className="h-5 w-5" strokeWidth={1.5} />
                </button>

                <button
                  type="button"
                  onClick={() => handleSkip(-5)}
                  disabled={!canControl}
                  className="rounded-xl p-2.5 text-slate-400 transition hover:text-white hover:bg-white/8 disabled:opacity-20 disabled:cursor-not-allowed"
                >
                  <Rewind className="h-5 w-5" strokeWidth={1.5} />
                </button>

                <button
                  type="button"
                  onClick={handlePlayPause}
                  disabled={!canPlay && !canControl}
                  className="mx-1 flex h-14 w-14 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-600/25 transition hover:bg-rose-400 hover:shadow-rose-600/35 active:scale-95 disabled:opacity-25 disabled:shadow-none disabled:cursor-not-allowed"
                >
                  {state.streaming && !state.paused ? (
                    <Pause
                      className="h-6 w-6"
                      strokeWidth={2.5}
                      fill="currentColor"
                    />
                  ) : (
                    <Play
                      className="h-6 w-6 translate-x-0.5"
                      strokeWidth={2.5}
                      fill="currentColor"
                    />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleSkip(5)}
                  disabled={!canControl}
                  className="rounded-xl p-2.5 text-slate-400 transition hover:text-white hover:bg-white/8 disabled:opacity-20 disabled:cursor-not-allowed"
                >
                  <FastForward className="h-5 w-5" strokeWidth={1.5} />
                </button>

                <button
                  type="button"
                  onClick={handleStop}
                  disabled={!canControl}
                  className="rounded-xl p-2.5 text-slate-500 transition hover:text-red-300 hover:bg-white/8 disabled:opacity-20 disabled:cursor-not-allowed"
                >
                  <Square className="h-5 w-5" strokeWidth={1.5} />
                </button>
              </div>
            </div>

            {/* Vertical Volume */}
            <div className="flex flex-col items-center gap-1.5 border-l border-white/8 pl-3 ml-1">
              <VolumeIcon
                className="h-3.5 w-3.5 text-slate-500"
                strokeWidth={1.5}
              />
              <input
                className="volume-range"
                type="range"
                min="0"
                max="100"
                step="1"
                value={state.volume}
                onChange={handleVolume}
                style={{
                  background: `linear-gradient(to top, rgba(148,163,184,0.5) 0%, rgba(244,63,94,0.6) ${state.volume}%, rgba(255,255,255,0.06) ${state.volume}%)`,
                }}
              />
              <span className="w-6 text-center text-[10px] font-medium tabular-nums text-slate-600">
                {Math.round(state.volume)}
              </span>
            </div>
          </div>
        </section>

        {/* ─── Subtitle Panel (slides down below card) ─── */}
        <div
          className={`grid transition-all duration-250 ease-out ${
            showSubPanel
              ? 'grid-rows-[1fr] opacity-100'
              : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden">
            <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 backdrop-blur-xl">
              {subtitlesLoaded ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 rounded-md bg-rose-500/10 px-2 py-1 text-[11px] font-semibold text-rose-400 tracking-wide">
                    <Captions className="h-3 w-3" strokeWidth={2} />
                    CC
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setSubtitlesVisible((v) => !v)}
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
                      subtitlesVisible
                        ? 'bg-white/8 text-slate-300'
                        : 'text-slate-500 hover:text-slate-400'
                    }`}
                  >
                    {subtitlesVisible ? (
                      <>
                        <Eye className="h-3 w-3" strokeWidth={1.8} />
                        Visible
                      </>
                    ) : (
                      <>
                        <EyeOff className="h-3 w-3" strokeWidth={1.8} />
                        Hidden
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleRemoveSubtitles}
                    className="rounded-lg p-1 text-slate-500 transition hover:text-red-300 hover:bg-white/8"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={handleLoadSubtitles}
                  className="flex items-center gap-2"
                >
                  <input
                    className="flex-1 min-w-0 rounded-lg border border-white/8 bg-white/5 px-3 py-1.5 text-xs text-white outline-none placeholder:text-slate-600 focus:border-rose-500/25 transition-colors"
                    type="url"
                    value={subtitleUrl}
                    onChange={(e) => setSubtitleUrl(e.target.value)}
                    placeholder="Subtitle URL (.srt, .vtt)"
                  />
                  <button
                    type="submit"
                    disabled={!subtitleUrl.trim()}
                    className="shrink-0 rounded-lg bg-white/8 px-3 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-white/12 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSubPanel(false)}
                    className="shrink-0 rounded-lg p-1 text-slate-500 transition hover:text-slate-300"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>

        {/* ─── Error ─── */}
        {state.error && (
          <div className="flex items-start gap-2.5 rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3">
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-red-300"
              strokeWidth={1.6}
            />
            <p className="text-sm text-red-200/90">{state.error}</p>
          </div>
        )}

        {/* ─── History ─── */}
        <HistoryList
          onPlay={(url) => {
            setUrlInput(url)
            playUrl(url)
          }}
        />
      </div>
    </main>
  )
}
