import { describe, it, expect } from 'vitest'
import { apiUrlToHtmlUrl, GitHubProvider } from './github'
import type { FetchFn } from './github'

describe('apiUrlToHtmlUrl', () => {
  it('pulls API URL을 web pull URL로 바꾼다', () => {
    expect(
      apiUrlToHtmlUrl('https://api.github.com/repos/o/r/pulls/123'),
    ).toBe('https://github.com/o/r/pull/123')
  })

  it('issues는 그대로 issues', () => {
    expect(
      apiUrlToHtmlUrl('https://api.github.com/repos/o/r/issues/45'),
    ).toBe('https://github.com/o/r/issues/45')
  })

  it('commits는 commit로 단수화', () => {
    expect(
      apiUrlToHtmlUrl('https://api.github.com/repos/o/r/commits/abc'),
    ).toBe('https://github.com/o/r/commit/abc')
  })

  it('null이면 알림 페이지로 폴백', () => {
    expect(apiUrlToHtmlUrl(null)).toBe('https://github.com/notifications')
  })

  it('빈 문자열도 알림 페이지로 폴백', () => {
    expect(apiUrlToHtmlUrl('')).toBe('https://github.com/notifications')
  })
})

function makeRes(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'Content-Type': 'application/json' },
  })
}

const thread = {
  id: '1',
  unread: true,
  reason: 'mention',
  updated_at: '2026-06-17T12:00:00Z',
  subject: {
    title: 'Fix the bug',
    type: 'PullRequest',
    url: 'https://api.github.com/repos/o/r/pulls/123',
  },
  repository: { full_name: 'o/r' },
}

describe('GitHubProvider.poll', () => {
  it('200 응답을 NotifItem으로 매핑한다', async () => {
    const fetchFn: FetchFn = async () =>
      makeRes([thread], { headers: { 'Last-Modified': 'Wed, 17 Jun 2026 12:00:00 GMT' } })
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    const res = await provider.poll()
    expect(res.notModified).toBe(false)
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      id: '1',
      provider: 'github',
      title: 'Fix the bug',
      url: 'https://github.com/o/r/pull/123',
      type: 'mention',
      read: false,
    })
    expect(res.lastModified).toBe('Wed, 17 Jun 2026 12:00:00 GMT')
  })

  it('승인된 PR은 type=approved로 라벨한다', async () => {
    const prThread = {
      id: '7',
      unread: true,
      reason: 'author',
      updated_at: '2026-06-17T12:00:00Z',
      subject: { title: 'feat: x', type: 'PullRequest', url: 'https://api.github.com/repos/o/r/pulls/7' },
      repository: { full_name: 'o/r' },
    }
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/reviews')) {
        return makeRes([
          { state: 'COMMENTED', submitted_at: '2026-06-17T11:00:00Z' },
          { state: 'APPROVED', submitted_at: '2026-06-17T11:30:00Z' },
        ])
      }
      return makeRes([prThread])
    }
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    const res = await provider.poll()
    expect(res.items[0]?.type).toBe('approved')
  })

  it('unread=false 스레드는 read=true로 매핑한다', async () => {
    const readThread = { ...thread, id: '5', unread: false }
    const fetchFn: FetchFn = async () => makeRes([readThread])
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    const res = await provider.poll()
    expect(res.items[0]?.read).toBe(true)
  })

  it('markRead는 thread id로 PATCH를 보낸다', async () => {
    let calledUrl: string | undefined
    let calledMethod: string | undefined
    const fetchFn: FetchFn = async (url, init) => {
      calledUrl = url
      calledMethod = init?.method
      return makeRes(null, { status: 205 })
    }
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    await provider.markRead('42')
    expect(calledMethod).toBe('PATCH')
    expect(calledUrl).toBe('https://api.github.com/notifications/threads/42')
  })

  it("reason 'author'를 author 타입으로 매핑한다 (내 PR/이슈)", async () => {
    const authorThread = { ...thread, id: '9', reason: 'author' }
    const fetchFn: FetchFn = async () => makeRes([authorThread])
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    const res = await provider.poll()
    expect(res.items[0]?.type).toBe('author')
  })

  it('304면 notModified=true, items 비어있음', async () => {
    const fetchFn: FetchFn = async () => makeRes(null, { status: 304 })
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    const res = await provider.poll({ lastModified: 'X' })
    expect(res.notModified).toBe(true)
    expect(res.items).toHaveLength(0)
  })

  it('lastModified가 있으면 If-Modified-Since 헤더를 보낸다', async () => {
    let sent: Record<string, string> | undefined
    const fetchFn: FetchFn = async (_url, init) => {
      sent = init?.headers
      return makeRes(null, { status: 304 })
    }
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    await provider.poll({ lastModified: 'Wed, 17 Jun 2026 12:00:00 GMT' })
    expect(sent?.['If-Modified-Since']).toBe('Wed, 17 Jun 2026 12:00:00 GMT')
    expect(sent?.['Authorization']).toBe('Bearer tok')
  })

  it('401이면 UNAUTHORIZED 에러를 던진다', async () => {
    const fetchFn: FetchFn = async () => makeRes({}, { status: 401 })
    const provider = new GitHubProvider(async () => 'tok', fetchFn)
    await expect(provider.poll()).rejects.toThrow('UNAUTHORIZED')
  })

  it('토큰이 없으면 에러를 던진다', async () => {
    const fetchFn: FetchFn = async () => makeRes([])
    const provider = new GitHubProvider(async () => null, fetchFn)
    await expect(provider.poll()).rejects.toThrow()
  })
})
