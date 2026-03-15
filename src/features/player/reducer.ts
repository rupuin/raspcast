import type { PlayerServerMessage, PlayerState } from './types'

export type PlayerUiState = PlayerState & {
  connected: boolean
  reconnecting: boolean
  error: string | null
}

export const initialPlayerState: PlayerUiState = {
  streaming: false,
  url: '',
  title: '',
  position: 0,
  duration: 0,
  paused: false,
  volume: 100,
  connected: false,
  reconnecting: false,
  error: null,
}

export function playerReducer(
  state: PlayerUiState,
  action:
    | { type: 'connected' }
    | { type: 'reconnecting' }
    | { type: 'disconnected' }
    | { type: 'server_message'; message: PlayerServerMessage },
): PlayerUiState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true, reconnecting: false, error: null }
    case 'reconnecting':
      return { ...state, connected: false, reconnecting: true }
    case 'disconnected':
      return { ...state, connected: false, reconnecting: false }
    case 'server_message': {
      const msg = action.message
      switch (msg.type) {
        case 'snapshot':
          return { ...state, ...msg.value, error: null }
        case 'active':
          return { ...state, streaming: true, url: msg.value }
        case 'stopped':
          return { ...state, streaming: false, paused: false, position: 0 }
        case 'position':
          return { ...state, position: msg.value }
        case 'duration':
          return { ...state, duration: msg.value }
        case 'paused':
          return { ...state, paused: msg.value }
        case 'volume':
          return { ...state, volume: msg.value }
        case 'title':
          return { ...state, title: msg.value }
        case 'error':
          return { ...state, error: msg.error }
      }
    }
  }
}
