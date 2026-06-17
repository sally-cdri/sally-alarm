import type { NotificationProvider, NotifItem, PollerState } from './types'
import { filterNew } from './dedup'

export interface PollerDeps {
  provider: NotificationProvider
  onNew: (items: NotifItem[]) => void
  /** 폴링이 성공할 때마다 현재 전체 알림 목록(GitHub 기준 미읽음)을 전달한다. */
  onItems?: (items: NotifItem[]) => void
  /** 매 폴링 종료 시 결과(성공 여부)를 알린다 — 마지막 확인 시각/상태 표시용. */
  onTick?: (ok: boolean) => void
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
      if (res.notModified) {
        this.deps.onTick?.(true)
        return
      }
      if (res.lastModified) this.lastModified = res.lastModified

      // 목록은 이번 폴링의 현재 전체 알림으로 갱신한다(델타가 아님).
      this.deps.onItems?.(res.items)

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
      this.deps.onTick?.(true)
    } catch (e) {
      this.deps.onError?.(e)
      this.deps.onTick?.(false)
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
