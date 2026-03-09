import { Clock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getHistory } from './api'
import type { HistoryItem } from './types'

interface Props {
  onPlay: (url: string) => void
}

export function HistoryList({ onPlay }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([])

  useEffect(() => {
    getHistory()
      .then(setItems)
      .catch(() => {})
  }, [])

  return (
    <section className="mt-1 pb-4">
      <div className="flex items-center gap-3 px-1 mb-2">
        <Clock className="h-3 w-3 text-slate-600" strokeWidth={1.5} />
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-600">
          Recently played
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-white/6 to-transparent" />
      </div>

      <div className="space-y-px">
        {items.length > 0 ? (
          items.map((item) => (
            <button
              key={item.url}
              type="button"
              onClick={() => onPlay(item.url)}
              className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-slate-400 truncate transition-colors group-hover:text-white">
                  {item.title}
                </p>
              </div>
              <span className="shrink-0 text-[10px] tabular-nums text-slate-600">
                {item.lastPlayedAt}
              </span>
            </button>
          ))
        ) : (
          <p className="py-6 text-center text-xs text-slate-600">
            Your playback history will appear here
          </p>
        )}
      </div>
    </section>
  )
}
