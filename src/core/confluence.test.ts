import { describe, it, expect } from 'vitest'
import { ConfluenceProvider } from './confluence'
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

const searchBody = {
  results: [
    {
      content: { id: '123', title: '기획 문서', _links: { webui: '/spaces/PROJ/pages/123/기획' } },
      excerpt: '이번 스프린트 범위를   업데이트했습니다',
      lastModified: '2026-06-17T09:00:00.000Z',
    },
  ],
}

describe('ConfluenceProvider.poll', () => {
  it('검색 결과를 NotifItem으로 매핑한다(제목/URL/미리보기)', async () => {
    const fetchFn: FetchFn = async () => makeRes(searchBody)
    const provider = new ConfluenceProvider(
      async () => 'tok',
      async () => 'acme',
      async () => 'me@x.com',
      fetchFn,
    )
    const res = await provider.poll()
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      provider: 'confluence',
      title: '기획 문서',
      url: 'https://acme.atlassian.net/wiki/spaces/PROJ/pages/123/기획',
      preview: '이번 스프린트 범위를 업데이트했습니다',
      read: false,
    })
    expect(res.items[0]?.id).toBe('confluence:123:2026-06-17T09:00:00.000Z')
  })

  it('/wiki/rest/api/search로 Basic 인증 요청을 보낸다', async () => {
    let url: string | undefined
    let headers: Record<string, string> | undefined
    const fetchFn: FetchFn = async (u, init) => {
      url = u
      headers = init?.headers
      return makeRes(searchBody)
    }
    const provider = new ConfluenceProvider(
      async () => 'tok',
      async () => 'acme.atlassian.net',
      async () => 'me@x.com',
      fetchFn,
    )
    await provider.poll()
    expect(url).toContain('https://acme.atlassian.net/wiki/rest/api/search?cql=')
    expect(headers?.['Authorization']).toBe(`Basic ${btoa('me@x.com:tok')}`)
  })

  it('401이면 UNAUTHORIZED', async () => {
    const fetchFn: FetchFn = async () => makeRes({}, { status: 401 })
    const provider = new ConfluenceProvider(
      async () => 'tok',
      async () => 'acme',
      async () => 'me@x.com',
      fetchFn,
    )
    await expect(provider.poll()).rejects.toThrow('UNAUTHORIZED')
  })
})
