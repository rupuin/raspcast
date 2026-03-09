export type PlayerCommand =
  | { type: 'play'; url: string }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; percent: number }
  | { type: 'skip'; seconds: number }
  | { type: 'volume'; value: number }
  | { type: 'snapshot' }

export type PlayerState = {
  streaming: boolean
  url: string
  title: string
  position: number
  duration: number
  paused: boolean
  volume: number
}

export type PlayerServerMessage =
  | { type: 'active'; value: string }
  | { type: 'stopped' }
  | { type: 'position'; value: number }
  | { type: 'duration'; value: number }
  | { type: 'paused'; value: boolean }
  | { type: 'volume'; value: number }
  | { type: 'title'; value: string }
  | { type: 'snapshot'; value: PlayerState }
  | { type: 'error'; error: string }
