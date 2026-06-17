import { describe, it, expect } from 'vitest'
import { NotionProvider, notionPageId } from './notion'
import type { FetchFn } from './github'

function makeRes(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'Content-Type': 'application/json' },
  })
}

const page = {
  id: '1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60',
  url: 'https://www.notion.so/My-Page-1a2b3c4d5e6f7081920a1b2c3d4e5f60',
  last_edited_time: '2026-06-17T12:00:00Z',
  properties: {
    Name: { type: 'title', title: [{ plain_text: '주간 회의' }] },
  },
}

describe('notionPageId', () => {
  it('URL 끝의 32 hex를 UUID로 추출한다', () => {
    expect(notionPageId('https://www.notion.so/My-Page-1a2b3c4d5e6f7081920a1b2c3d4e5f60')).toBe(
      '1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60',
    )
  })

  it('대시 포함 UUID도 처리한다', () => {
    expect(notionPageId('1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60')).toBe(
      '1a2b3c4d-5e6f-7081-920a-1b2c3d4e5f60',
    )
  })

  it('hex가 없으면 null', () => {
    expect(notionPageId('https://www.notion.so/no-id-here')).toBeNull()
  })
})

describe('NotionProvider.poll', () => {
  it('페이지를 NotifItem으로 매핑한다(제목/시각/편집 id)', async () => {
    const fetchFn: FetchFn = async () => makeRes(page)
    const provider = new NotionProvider(
      async () => 'tok',
      async () => ['https://www.notion.so/My-Page-1a2b3c4d5e6f7081920a1b2c3d4e5f60'],
      fetchFn,
    )
    const res = await provider.poll()
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      provider: 'notion',
      title: '주간 회의',
      url: page.url,
      timestamp: '2026-06-17T12:00:00Z',
      read: false,
    })
    expect(res.items[0]?.id).toBe(`${page.id}:2026-06-17T12:00:00Z`)
  })

  it('Notion-Version과 Bearer 토큰 헤더를 보낸다', async () => {
    let sent: Record<string, string> | undefined
    const fetchFn: FetchFn = async (_url, init) => {
      sent = init?.headers
      return makeRes(page)
    }
    const provider = new NotionProvider(
      async () => 'tok',
      async () => ['1a2b3c4d5e6f7081920a1b2c3d4e5f60'],
      fetchFn,
    )
    await provider.poll()
    expect(sent?.['Authorization']).toBe('Bearer tok')
    expect(sent?.['Notion-Version']).toBe('2022-06-28')
  })

  it('401이면 UNAUTHORIZED', async () => {
    const fetchFn: FetchFn = async () => makeRes({}, { status: 401 })
    const provider = new NotionProvider(
      async () => 'tok',
      async () => ['1a2b3c4d5e6f7081920a1b2c3d4e5f60'],
      fetchFn,
    )
    await expect(provider.poll()).rejects.toThrow('UNAUTHORIZED')
  })

  it('개별 페이지 404는 건너뛴다', async () => {
    const fetchFn: FetchFn = async (url) =>
      url.includes('ffffffff') ? makeRes({}, { status: 404 }) : makeRes(page)
    const provider = new NotionProvider(
      async () => 'tok',
      async () => [
        'ffffffffffffffffffffffffffffffff',
        '1a2b3c4d5e6f7081920a1b2c3d4e5f60',
      ],
      fetchFn,
    )
    const res = await provider.poll()
    expect(res.items).toHaveLength(1)
  })

  it('토큰이 없으면 에러', async () => {
    const fetchFn: FetchFn = async () => makeRes(page)
    const provider = new NotionProvider(async () => null, async () => [], fetchFn)
    await expect(provider.poll()).rejects.toThrow()
  })
})
