import type { PlayerCommand, PlayerServerMessage } from './types'

const initialReconnectDelayMs = 300
const maxReconnectDelayMs = 3000
const connectTimeoutMs = 1500
const probeTimeoutMs = 900

export function getSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

export class PlayerWsClient {
  private ws: WebSocket | null = null
  private reconnectTimer: number | null = null
  private connectTimer: number | null = null
  private probeTimer: number | null = null
  private reconnectDelay = initialReconnectDelayMs
  private lastMessageAt = 0
  private manuallyClosed = false

  onOpen?: () => void
  onMessage?: (msg: PlayerServerMessage) => void
  onReconnecting?: () => void
  onClose?: () => void

  constructor(private readonly url: string) {}

  connect() {
    this.manuallyClosed = false
    this.bindLifecycleEvents()
    this.resume()
  }

  disconnect() {
    this.manuallyClosed = true
    this.unbindLifecycleEvents()
    this.closeSocket(1000, 'disconnect')
  }

  send(cmd: PlayerCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

  private handleVisibilityChange = () => {
    if (document.hidden) {
      this.pauseTimers()
      return
    }

    this.resume()
  }

  private handlePageHide = () => {
    this.closeSocket(1000, 'pagehide')
  }

  private handleForeground = () => {
    this.resume()
  }

  private resume() {
    if (this.manuallyClosed || document.hidden) {
      return
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.probe()
      return
    }

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    this.clearReconnectTimer()
    this.openSocket()
  }

  private bindLifecycleEvents() {
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('pagehide', this.handlePageHide)
    window.addEventListener('pageshow', this.handleForeground)
    window.addEventListener('focus', this.handleForeground)
    window.addEventListener('online', this.handleForeground)
  }

  private unbindLifecycleEvents() {
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    window.removeEventListener('pagehide', this.handlePageHide)
    window.removeEventListener('pageshow', this.handleForeground)
    window.removeEventListener('focus', this.handleForeground)
    window.removeEventListener('online', this.handleForeground)
  }

  private pauseTimers() {
    this.clearReconnectTimer()
    this.clearConnectTimer()
    this.clearProbeTimer()
  }

  private closeSocket(code?: number, reason?: string) {
    this.pauseTimers()

    if (!this.ws) {
      return
    }

    this.ws.onopen = null
    this.ws.onmessage = null
    this.ws.onclose = null
    this.ws.onerror = null
    this.ws.close(code, reason)
    this.ws = null
  }

  private openSocket() {
    this.onReconnecting?.()

    this.closeSocket()

    const ws = new WebSocket(this.url)
    this.ws = ws
    this.armConnectTimeout(ws)

    ws.onopen = () => {
      if (this.ws !== ws) {
        return
      }
      this.clearConnectTimer()
      this.clearProbeTimer()
      this.reconnectDelay = 300
      this.lastMessageAt = Date.now()
      this.onOpen?.()
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) {
        return
      }

      this.clearProbeTimer()
      this.lastMessageAt = Date.now()

      try {
        const message = JSON.parse(event.data) as PlayerServerMessage
        this.onMessage?.(message)
      } catch (err) {
        console.error('inbound ws message error', err)
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) {
        return
      }

      this.clearConnectTimer()
      this.clearProbeTimer()
      this.ws = null

      if (this.manuallyClosed) {
        this.onClose?.()
        return
      }

      if (document.hidden) {
        return
      }

      this.onReconnecting?.()
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      if (this.ws !== ws) {
        return
      }

      ws.close()
    }
  }

  private probe() {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return
    }

    const ws = this.ws
    const startedAt = Date.now()

    this.clearProbeTimer()
    this.send({ type: 'snapshot' })

    // On resume, keep the healthy socket if it answers quickly. If it does not,
    // force a fresh connection instead of waiting for Safari to notice.
    this.probeTimer = window.setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        return
      }

      if (this.lastMessageAt >= startedAt) {
        return
      }

      ws.close(1000, 'resume-probe')
      this.openSocket()
    }, probeTimeoutMs)
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) {
      return
    }

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      maxReconnectDelayMs,
    )

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.resume()
    }, delay)
  }

  private armConnectTimeout(ws: WebSocket) {
    this.clearConnectTimer()

    this.connectTimer = window.setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) {
        return
      }

      ws.close()
    }, connectTimeoutMs)
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private clearProbeTimer() {
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }
}
