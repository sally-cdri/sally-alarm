import { describe, it, expect } from 'vitest'
import { filterNew } from './dedup'
import type { NotifItem } from './types'

function item(id: string): NotifItem {
  return {
    id,
    provider: 'github',
    title: id,
    body: '',
    url: '',
    timestamp: '2026-06-17T00:00:00Z',
    type: 'other',
    read: false,
  }
}

describe('filterNew', () => {
  it('seen에 없는 항목만 반환한다', () => {
    const result = filterNew([item('1'), item('2'), item('3')], new Set(['2']))
    expect(result.map((i) => i.id)).toEqual(['1', '3'])
  })

  it('전부 seen이면 빈 배열', () => {
    expect(filterNew([item('1')], new Set(['1']))).toEqual([])
  })
})
