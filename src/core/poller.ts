import type { NotificationProvider, NotifItem, PollerState } from './types'
import { filterNew } from './dedup'

export interface PollerDeps {
  provider: NotificationProvider
  onNew: (items: NotifItem[]) => void
  onError?: (e: unknown) => void
  loadState: () => Promise<PollerState>
  saveState: (s: PollerState) => Promise<void>
  intervalSec: number
}

const MAX_SEEN = 500

export class Poller {
  private seen = new Set<string>()
  private lastModified?: string
  private timer?: ReturnType<typeof setInterval>

  constructor(private deps: PollerDeps) {}

  async init(): Promise<void> {
    const s = await this.deps.loadState()
    this.lastModified = s.lastModified
    this.seen = new Set(s.seenIds)
  }

  async tick(): Promise<void> {
    try {
      const res = await this.deps.provider.poll({ lastModified: this.lastModified })
      if (res.notModified) return
      if (res.lastModified) this.lastModified = res.lastModified

      const fresh = filterNew(res.items, this.seen)
      if (fresh.length > 0) {
        fresh.forEach((i) => this.seen.add(i.id))
        // seen 무한 증가 방지
        if (this.seen.size > MAX_SEEN) {
          this.seen = new Set([...this.seen].slice(-MAX_SEEN))
        }
        // onNew(알림 표시) 실패가 상태 저장을 막지 않도록 격리한다.
        // 실패해도 항목은 seen에 남기고 저장하여 재시작 시 중복 알림을 막는다.
        try {
          this.deps.onNew(fresh)
        } catch (e) {
          this.deps.onError?.(e)
        }
      }
      await this.deps.saveState({ lastModified: this.lastModified, seenIds: [...this.seen] })
    } catch (e) {
      this.deps.onError?.(e)
    }
  }

  start(): void {
    this.stop()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalSec * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
