import type { PlayerCommand, PlayerServerMessage } from './types'

export function getSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

export class PlayerWsClient {
  private ws: WebSocket | null = null
  private reconnectTimer: number | null = null
  private connectTimer: number | null = null
  private reconnectDelay = 300
  private manuallyClosed = false
  private url: string

  onOpen?: () => void
  onMessage?: (msg: PlayerServerMessage) => void
  onReconnecting?: () => void
  onClose?: () => void

  constructor(url: string) {
    this.url = url
  }

  connect() {
    this.manuallyClosed = false
    this.resume()
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('pagehide', this.handlePageHide)
    window.addEventListener('pageshow', this.handlePageShow)
    window.addEventListener('focus', this.handleFocus)
    window.addEventListener('online', this.handleOnline)
  }

  disconnect() {
    this.manuallyClosed = true
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    window.removeEventListener('pagehide', this.handlePageHide)
    window.removeEventListener('pageshow', this.handlePageShow)
    window.removeEventListener('focus', this.handleFocus)
    window.removeEventListener('online', this.handleOnline)
    this.suspend()
  }

  send(cmd: PlayerCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

  private handleVisibilityChange = () => {
    if (document.hidden) {
      this.suspend()
      return
    }

    this.resume()
  }

  private handlePageHide = () => {
    this.suspend()
  }

  private handlePageShow = () => {
    this.resume()
  }

  private handleFocus = () => {
    this.resume()
  }

  private handleOnline = () => {
    this.resume()
  }

  private resume() {
    if (this.manuallyClosed || document.hidden) {
      return
    }

    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return
    }

    this.clearReconnectTimer()
    this.doConnect()
  }

  private suspend() {
    this.clearReconnectTimer()
    this.clearConnectTimer()

    if (!this.ws) {
      return
    }

    this.ws.onopen = null
    this.ws.onmessage = null
    this.ws.onclose = null
    this.ws.onerror = null
    this.ws.close()
    this.ws = null
  }

  private doConnect() {
    this.onReconnecting?.()

    this.suspend()

    const ws = new WebSocket(this.url)
    this.ws = ws
    this.armConnectTimeout(ws)

    ws.onopen = () => {
      if (this.ws !== ws) {
        return
      }
      this.clearConnectTimer()
      this.reconnectDelay = 300
      this.onOpen?.()
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) {
        return
      }

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

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) {
      return
    }

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 3000)

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
    }, 1500)
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
}
