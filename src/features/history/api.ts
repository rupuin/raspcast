import { type HistoryItem } from './types'

export async function getHistory(): Promise<HistoryItem[]> {
  const response = await fetch('/history')

  if (!response.ok) {
    throw new Error('Error retrieving history')
  }

  const data = (await response.json()) as { items: HistoryItem[] }
  return data.items
}
