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

  disconnect() {
    this.manuallyClosed = true

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

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }
}
