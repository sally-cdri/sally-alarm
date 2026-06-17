import type { NotifItem } from './types'

export function filterNew(items: NotifItem[], seenIds: Set<string>): NotifItem[] {
  return items.filter((i) => !seenIds.has(i.id))
}
