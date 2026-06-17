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

  it('onNew가 던져도 onError로 흡수하고 상태는 저장한다', async () => {
    const saved: PollerState[] = []
    const onError = vi.fn()
    const deps: PollerDeps = {
      provider: { id: 'github', poll: async () => ({ items: [item('1')], notModified: false }) },
      onNew: () => {
        throw new Error('notify failed')
      },
      onError,
      loadState: async () => ({ seenIds: [] }),
      saveState: async (s) => {
        saved.push(s)
      },
      intervalSec: 60,
    }
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    expect(onError).toHaveBeenCalled()
    expect(saved[saved.length - 1]?.seenIds).toContain('1')
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

  it('onItems로 현재 전체 목록을 전달한다(델타가 아님)', async () => {
    const onItems = vi.fn()
    const deps: PollerDeps = {
      provider: { id: 'github', poll: async () => ({ items: [item('1'), item('2')], notModified: false }) },
      onNew: vi.fn(),
      onItems,
      loadState: async () => ({ seenIds: ['1'] }), // 1은 이미 봤어도 목록엔 전체가 와야 함
      saveState: async () => {},
      intervalSec: 60,
    }
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    expect(onItems).toHaveBeenCalledWith([item('1'), item('2')])
  })

  it('onTick은 성공/304/에러에 맞게 호출된다', async () => {
    const okTick = vi.fn()
    const okDeps: PollerDeps = {
      provider: { id: 'github', poll: async () => ({ items: [], notModified: false }) },
      onNew: vi.fn(),
      onTick: okTick,
      loadState: async () => ({ seenIds: [] }),
      saveState: async () => {},
      intervalSec: 60,
    }
    const p1 = new Poller(okDeps)
    await p1.init()
    await p1.tick()
    expect(okTick).toHaveBeenLastCalledWith(true)

    const nmTick = vi.fn()
    const nmDeps: PollerDeps = {
      provider: { id: 'github', poll: async () => ({ items: [], notModified: true }) },
      onNew: vi.fn(),
      onTick: nmTick,
      loadState: async () => ({ seenIds: [] }),
      saveState: async () => {},
      intervalSec: 60,
    }
    const p2 = new Poller(nmDeps)
    await p2.init()
    await p2.tick()
    expect(nmTick).toHaveBeenLastCalledWith(true)

    const errTick = vi.fn()
    const errDeps: PollerDeps = {
      provider: { id: 'github', poll: async () => { throw new Error('x') } },
      onNew: vi.fn(),
      onTick: errTick,
      onError: vi.fn(),
      loadState: async () => ({ seenIds: [] }),
      saveState: async () => {},
      intervalSec: 60,
    }
    const p3 = new Poller(errDeps)
    await p3.init()
    await p3.tick()
    expect(errTick).toHaveBeenLastCalledWith(false)
  })
})
