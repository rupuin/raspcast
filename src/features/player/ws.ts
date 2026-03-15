import type { PlayerCommand, PlayerServerMessage } from './types'

export function getSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

export class PlayerWsClient {
  private ws: WebSocket | null = null
  private reconnectTimer: number | null = null
  private manuallyClosed = false
  private url: string

  onOpen?: () => void
  onMessage?: (msg: PlayerServerMessage) => void
  onClose?: () => void

  constructor(url: string) {
    this.url = url
  }

  connect() {
    this.manuallyClosed = false
    this.doConnect()
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('pageshow', this.handlePageShow)
  }

  disconnect() {
    this.manuallyClosed = true
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    window.removeEventListener('pageshow', this.handlePageShow)

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
  }

  send(cmd: PlayerCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

  private handleVisibilityChange = () => {
    if (document.hidden || this.manuallyClosed) return

    // iOS can leave the socket in a zombie OPEN state after backgrounding,
    // or simply not fire onclose — force reconnect when returning to foreground.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.doConnect()
  }

  private doConnect() {
    // Null out handlers on stale socket to avoid duplicate callbacks
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.onOpen?.()
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as PlayerServerMessage
        this.onMessage?.(message)
      } catch (err) {
        console.error('inbound ws message error', err)
      }
    }

    this.ws.onclose = () => {
      this.onClose?.()

      if (!this.manuallyClosed) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect()
    }, 300)
  }

  private handlePageShow = (e: PageTransitionEvent) => {
    if (e.persisted && !this.manuallyClosed) {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.doConnect()
    }
  }
}
