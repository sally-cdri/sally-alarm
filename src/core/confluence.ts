import type {
  NotificationProvider,
  NotifItem,
  PollOptions,
  PollResult,
  ProviderId,
} from './types'
import type { FetchFn } from './github'
import { normalizeJiraSite } from './jira'

interface ConfluenceResult {
  content?: { id?: string; title?: string; _links?: { webui?: string } }
  title?: string
  excerpt?: string
  lastModified?: string
}

// 내가 만들거나/기여하거나/멘션되거나/관찰하는 페이지 중 최근 수정된 것.
const CQL =
  'type=page and (creator = currentUser() OR contributor = currentUser() OR mention = currentUser() OR watcher = currentUser()) and lastmodified >= startOfDay("-7d") order by lastmodified desc'

function previewOf(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 140 ? `${t.slice(0, 140)}…` : t
}

export class ConfluenceProvider implements NotificationProvider {
  readonly id: ProviderId = 'confluence'

  constructor(
    private getToken: () => Promise<string | null>,
    private getSite: () => Promise<string>,
    private getEmail: () => Promise<string>,
    private fetchFn: FetchFn,
  ) {}

  async poll(_opts: PollOptions = {}): Promise<PollResult> {
    const token = await this.getToken()
    if (!token) throw new Error('Atlassian 토큰이 설정되지 않았습니다')
    const base = normalizeJiraSite(await this.getSite())
    const email = (await this.getEmail()).trim()
    if (!base || !email) throw new Error('Atlassian 사이트/이메일이 설정되지 않았습니다')

    const auth = btoa(`${email}:${token}`)
    const url = `${base}/wiki/rest/api/search?cql=${encodeURIComponent(CQL)}&limit=25&excerpt=indexed`
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'User-Agent': 'sally-alarm',
      },
    })

    if (res.status === 401) throw new Error('UNAUTHORIZED')
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { message?: string }
        if (body?.message) detail = ` - ${body.message}`
      } catch {
        // 무시
      }
      throw new Error(`Confluence API 오류: ${res.status}${detail}`)
    }

    const data = (await res.json()) as { results?: ConfluenceResult[] }
    const items: NotifItem[] = (data.results ?? []).map((r) => {
      const id = r.content?.id ?? ''
      const updated = r.lastModified ?? ''
      const webui = r.content?._links?.webui ?? ''
      return {
        id: `confluence:${id}:${updated}`,
        provider: 'confluence',
        title: r.content?.title ?? r.title ?? '(제목 없음)',
        body: 'Confluence 페이지 수정됨',
        url: webui ? `${base}/wiki${webui}` : `${base}/wiki`,
        timestamp: updated,
        type: 'other',
        read: false,
        preview: r.excerpt ? previewOf(r.excerpt) : undefined,
      }
    })
    return { items, notModified: false }
  }
}
