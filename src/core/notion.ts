import type {
  NotificationProvider,
  NotifItem,
  PollOptions,
  PollResult,
  ProviderId,
} from './types'
import type { FetchFn } from './github'

const NOTION_VERSION = '2022-06-28'

interface NotionTitleProp {
  type?: string
  title?: { plain_text?: string }[]
}

interface NotionPage {
  id: string
  url: string
  last_edited_time: string
  properties?: Record<string, NotionTitleProp>
}

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Notion 페이지 URL(또는 ID)에서 페이지 UUID를 추출한다. */
export function notionPageId(input: string): string | null {
  // 쿼리/해시/끝 슬래시 제거 후 대시를 떼고, 맨 끝의 32 hex(페이지 ID)를 앵커링한다.
  const cleaned = input
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/-/g, '')
  const m = cleaned.match(/[0-9a-fA-F]{32}$/)
  if (!m) return null
  return formatUuid(m[0].toLowerCase())
}

function pageTitle(page: NotionPage): string {
  const props = page.properties ?? {}
  for (const key of Object.keys(props)) {
    const p = props[key]
    if (p?.type === 'title' && Array.isArray(p.title)) {
      const t = p.title.map((x) => x?.plain_text ?? '').join('').trim()
      if (t) return t
    }
  }
  return '제목 없음'
}

function toItem(page: NotionPage): NotifItem {
  return {
    // 편집 시각을 id에 포함 → 페이지가 수정될 때마다 새 알림으로 인식
    id: `${page.id}:${page.last_edited_time}`,
    provider: 'notion',
    title: pageTitle(page),
    body: 'Notion 페이지 수정됨',
    url: page.url,
    timestamp: page.last_edited_time,
    type: 'other',
    read: false,
  }
}

export class NotionProvider implements NotificationProvider {
  readonly id: ProviderId = 'notion'

  constructor(
    private getToken: () => Promise<string | null>,
    private getPages: () => Promise<string[]>,
    private fetchFn: FetchFn,
  ) {}

  async poll(_opts: PollOptions = {}): Promise<PollResult> {
    const token = await this.getToken()
    if (!token) throw new Error('Notion 토큰이 설정되지 않았습니다')

    const pages = await this.getPages()
    const ids = pages
      .map(notionPageId)
      .filter((x): x is string => x !== null)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'User-Agent': 'sally-alarm',
    }

    const items: NotifItem[] = []
    for (const id of ids) {
      const res = await this.fetchFn(`https://api.notion.com/v1/pages/${id}`, {
        method: 'GET',
        headers,
      })
      if (res.status === 401) throw new Error('UNAUTHORIZED')
      // 개별 페이지 접근 실패(404=미공유 등)는 건너뛰고 나머지를 계속 확인한다.
      if (!res.ok) continue
      const page = (await res.json()) as NotionPage
      items.push(toItem(page))
    }
    return { items, notModified: false }
  }
}
