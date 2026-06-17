import type {
  NotificationProvider,
  NotifItem,
  PollOptions,
  PollResult,
  ProviderId,
} from './types'
import type { FetchFn } from './github'

interface FigmaComment {
  id: string
  message: string
  created_at: string
  user?: { handle?: string }
}

/** Figma 파일 URL(또는 키)에서 file key를 추출한다. */
export function figmaFileKey(input: string): string | null {
  const url = input.trim()
  const m = url.match(/figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/)
  if (m) return m[1]
  if (/^[A-Za-z0-9]{10,}$/.test(url)) return url
  return null
}

function toItem(c: FigmaComment, fileUrl: string): NotifItem {
  return {
    id: `figma:${c.id}`,
    provider: 'figma',
    title: c.message?.trim() || '(빈 댓글)',
    body: `Figma · ${c.user?.handle ?? ''}`.trim(),
    url: fileUrl,
    timestamp: c.created_at,
    type: 'reply',
    read: false,
  }
}

export class FigmaProvider implements NotificationProvider {
  readonly id: ProviderId = 'figma'

  constructor(
    private getToken: () => Promise<string | null>,
    private getFiles: () => Promise<string[]>,
    private fetchFn: FetchFn,
    private getMention: () => Promise<string> = async () => '',
  ) {}

  async poll(_opts: PollOptions = {}): Promise<PollResult> {
    const token = await this.getToken()
    if (!token) throw new Error('Figma 토큰이 설정되지 않았습니다')

    const files = await this.getFiles()
    const mention = (await this.getMention()).trim().toLowerCase()
    // 오늘(로컬 자정) 이후 작성된 댓글만 — 오래된 백로그 제외.
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const minTs = startOfToday.getTime()
    const headers: Record<string, string> = {
      'X-Figma-Token': token,
      'User-Agent': 'sally-alarm',
    }

    const items: NotifItem[] = []
    for (const fileUrl of files) {
      const key = figmaFileKey(fileUrl)
      if (!key) continue
      const res = await this.fetchFn(
        `https://api.figma.com/v1/files/${key}/comments`,
        { method: 'GET', headers },
      )
      if (res.status === 401 || res.status === 403) throw new Error('UNAUTHORIZED')
      // 개별 파일 접근 실패는 건너뛴다.
      if (!res.ok) continue
      const data = (await res.json()) as { comments?: FigmaComment[] }
      for (const c of data.comments ?? []) {
        // 오늘 이전 댓글 제외.
        const ts = new Date(c.created_at).getTime()
        if (Number.isNaN(ts) || ts < minTs) continue
        // 멘션 키워드가 설정되면 메시지에 포함된 댓글만 (Figma는 구조화된 멘션 배열이 없음).
        if (mention && !(c.message ?? '').toLowerCase().includes(mention)) continue
        items.push(toItem(c, fileUrl))
      }
    }
    return { items, notModified: false }
  }
}
