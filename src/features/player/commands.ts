import type { PlayerCommand } from './types'

export const playerCommand = {
  play: (url: string): PlayerCommand => ({ type: 'play', url }),
  pause: (): PlayerCommand => ({ type: 'pause' }),
  stop: (): PlayerCommand => ({ type: 'stop' }),
  seek: (percent: number): PlayerCommand => ({ type: 'seek', percent }),
  skip: (seconds: number): PlayerCommand => ({ type: 'skip', seconds }),
  volume: (value: number): PlayerCommand => ({ type: 'volume', value }),
  snapshot: (): PlayerCommand => ({ type: 'snapshot' }),
}
