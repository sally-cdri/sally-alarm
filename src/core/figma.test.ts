import { describe, it, expect } from 'vitest'
import { FigmaProvider, figmaFileKey } from './figma'
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

const fileUrl = 'https://www.figma.com/file/ABc123XYz/My-Design'

const commentsBody = {
  comments: [
    { id: 'c1', message: '여기 색상 바꿔주세요', created_at: '2026-06-17T09:00:00Z', user: { handle: 'jin' } },
    { id: 'c2', message: '확인했습니다', created_at: '2026-06-17T10:00:00Z', user: { handle: 'sue' } },
  ],
}

describe('figmaFileKey', () => {
  it('file URL에서 키 추출', () => {
    expect(figmaFileKey('https://www.figma.com/file/ABc123XYz/My-Design')).toBe('ABc123XYz')
  })
  it('design URL에서 키 추출', () => {
    expect(figmaFileKey('https://www.figma.com/design/KEY456abc/Title?node-id=1')).toBe('KEY456abc')
  })
  it('형식이 아니면 null', () => {
    expect(figmaFileKey('https://example.com/x')).toBeNull()
  })
})

describe('FigmaProvider.poll', () => {
  it('파일 댓글을 NotifItem으로 매핑한다', async () => {
    const fetchFn: FetchFn = async () => makeRes(commentsBody)
    const provider = new FigmaProvider(async () => 'tok', async () => [fileUrl], fetchFn)
    const res = await provider.poll()
    expect(res.items).toHaveLength(2)
    expect(res.items[0]).toMatchObject({
      id: 'figma:c1',
      provider: 'figma',
      title: '여기 색상 바꿔주세요',
      url: fileUrl,
      type: 'reply',
      read: false,
    })
  })

  it('X-Figma-Token 헤더를 보낸다', async () => {
    let sent: Record<string, string> | undefined
    const fetchFn: FetchFn = async (_url, init) => {
      sent = init?.headers
      return makeRes(commentsBody)
    }
    const provider = new FigmaProvider(async () => 'tok', async () => [fileUrl], fetchFn)
    await provider.poll()
    expect(sent?.['X-Figma-Token']).toBe('tok')
  })

  it('403이면 UNAUTHORIZED', async () => {
    const fetchFn: FetchFn = async () => makeRes({}, { status: 403 })
    const provider = new FigmaProvider(async () => 'tok', async () => [fileUrl], fetchFn)
    await expect(provider.poll()).rejects.toThrow('UNAUTHORIZED')
  })

  it('토큰이 없으면 에러', async () => {
    const fetchFn: FetchFn = async () => makeRes(commentsBody)
    const provider = new FigmaProvider(async () => null, async () => [], fetchFn)
    await expect(provider.poll()).rejects.toThrow()
  })
})
