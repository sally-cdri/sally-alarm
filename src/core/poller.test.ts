import { describe, it, expect, vi } from 'vitest'
import { Poller } from './poller'
import type { PollerDeps } from './poller'
import type { NotifItem, PollResult, PollerState } from './types'

function item(id: string): NotifItem {
  return { id, provider: 'github', title: id, body: '', url: '', timestamp: '', type: 'other' }
}

function makeDeps(results: PollResult[]): { deps: PollerDeps; saved: PollerState[]; onNew: ReturnType<typeof vi.fn> } {
  let i = 0
  const saved: PollerState[] = []
  const onNew = vi.fn()
  const deps: PollerDeps = {
    provider: { id: 'github', poll: async () => results[Math.min(i++, results.length - 1)] },
    onNew,
    loadState: async () => ({ seenIds: [] }),
    saveState: async (s) => { saved.push(s) },
    intervalSec: 60,
  }
  return { deps, saved, onNew }
}

describe('Poller.tick', () => {
  it('새 항목만 onNew로 전달하고 상태를 저장한다', async () => {
    const { deps, saved, onNew } = makeDeps([
      { items: [item('1'), item('2')], notModified: false, lastModified: 'LM1' },
    ])
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    expect(onNew).toHaveBeenCalledWith([item('1'), item('2')])
    expect(saved[saved.length - 1]?.lastModified).toBe('LM1')
    expect(saved[saved.length - 1]?.seenIds.sort()).toEqual(['1', '2'])
  })

  it('이미 본 항목은 두번째 tick에서 onNew 안함', async () => {
    const { deps, onNew } = makeDeps([
      { items: [item('1')], notModified: false },
      { items: [item('1')], notModified: false },
    ])
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    await poller.tick()
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('notModified면 onNew를 부르지 않는다', async () => {
    const { deps, onNew } = makeDeps([{ items: [], notModified: true }])
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    expect(onNew).not.toHaveBeenCalled()
  })

  it('poll이 에러를 던지면 onError로 전달하고 throw하지 않는다', async () => {
    const onError = vi.fn()
    const deps: PollerDeps = {
      provider: { id: 'github', poll: async () => { throw new Error('boom') } },
      onNew: vi.fn(),
      onError,
      loadState: async () => ({ seenIds: [] }),
      saveState: async () => {},
      intervalSec: 60,
    }
    const poller = new Poller(deps)
    await poller.init()
    await expect(poller.tick()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })
})
