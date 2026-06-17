import { describe, it, expect } from 'vitest'
import { JiraProvider, normalizeJiraSite } from './jira'
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

const issuesBody = {
  issues: [
    { key: 'PROJ-12', fields: { summary: '로그인 버그', updated: '2026-06-17T09:00:00.000+0000' } },
  ],
}

describe('normalizeJiraSite', () => {
  it('짧은 이름은 atlassian.net 붙임', () => {
    expect(normalizeJiraSite('acme')).toBe('https://acme.atlassian.net')
  })
  it('도메인은 https만 붙임', () => {
    expect(normalizeJiraSite('acme.atlassian.net')).toBe('https://acme.atlassian.net')
  })
  it('전체 URL은 끝 슬래시 제거', () => {
    expect(normalizeJiraSite('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net')
  })
})

describe('JiraProvider.poll', () => {
  it('이슈를 NotifItem으로 매핑한다', async () => {
    const fetchFn: FetchFn = async () => makeRes(issuesBody)
    const provider = new JiraProvider(
      async () => 'tok',
      async () => 'acme',
      async () => 'me@x.com',
      fetchFn,
    )
    const res = await provider.poll()
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      provider: 'jira',
      title: '로그인 버그',
      url: 'https://acme.atlassian.net/browse/PROJ-12',
      read: false,
    })
    expect(res.items[0]?.id).toBe('jira:PROJ-12:2026-06-17T09:00:00.000+0000')
  })

  it('search/jql에 POST + Basic 인증 + body를 보낸다', async () => {
    let method: string | undefined
    let url: string | undefined
    let headers: Record<string, string> | undefined
    let body: string | undefined
    const fetchFn: FetchFn = async (u, init) => {
      url = u
      method = init?.method
      headers = init?.headers
      body = init?.body
      return makeRes(issuesBody)
    }
    const provider = new JiraProvider(
      async () => 'tok',
      async () => 'acme.atlassian.net',
      async () => 'me@x.com',
      fetchFn,
    )
    await provider.poll()
    expect(method).toBe('POST')
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(headers?.['Authorization']).toBe(`Basic ${btoa('me@x.com:tok')}`)
    expect(body && JSON.parse(body).jql).toContain('currentUser()')
  })

  it('401이면 UNAUTHORIZED', async () => {
    const fetchFn: FetchFn = async () => makeRes({}, { status: 401 })
    const provider = new JiraProvider(
      async () => 'tok',
      async () => 'acme',
      async () => 'me@x.com',
      fetchFn,
    )
    await expect(provider.poll()).rejects.toThrow('UNAUTHORIZED')
  })

  it('사이트/이메일이 없으면 에러', async () => {
    const fetchFn: FetchFn = async () => makeRes(issuesBody)
    const provider = new JiraProvider(async () => 'tok', async () => '', async () => '', fetchFn)
    await expect(provider.poll()).rejects.toThrow()
  })
})
