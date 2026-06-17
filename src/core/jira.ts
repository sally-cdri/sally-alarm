import type {
  NotificationProvider,
  NotifItem,
  PollOptions,
  PollResult,
  ProviderId,
} from './types'
import type { FetchFn } from './github'

interface JiraIssue {
  key: string
  fields?: { summary?: string; updated?: string }
}

const JQL =
  '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -7d ORDER BY updated DESC'

/** 사이트 입력(`acme` / `acme.atlassian.net` / `https://acme.atlassian.net/`)을 base URL로 정규화. */
export function normalizeJiraSite(input: string): string {
  let v = input.trim().replace(/\/+$/, '')
  if (!v) return ''
  if (!/^https?:\/\//.test(v)) {
    v = v.includes('.') ? `https://${v}` : `https://${v}.atlassian.net`
  }
  return v
}

function toItem(issue: JiraIssue, base: string): NotifItem {
  const updated = issue.fields?.updated ?? ''
  return {
    id: `jira:${issue.key}:${updated}`,
    provider: 'jira',
    title: issue.fields?.summary ?? issue.key,
    body: `Jira · ${issue.key}`,
    url: `${base}/browse/${issue.key}`,
    timestamp: updated,
    type: 'other',
    read: false,
  }
}

export class JiraProvider implements NotificationProvider {
  readonly id: ProviderId = 'jira'

  constructor(
    private getToken: () => Promise<string | null>,
    private getSite: () => Promise<string>,
    private getEmail: () => Promise<string>,
    private fetchFn: FetchFn,
  ) {}

  async poll(_opts: PollOptions = {}): Promise<PollResult> {
    const token = await this.getToken()
    if (!token) throw new Error('Jira 토큰이 설정되지 않았습니다')
    const base = normalizeJiraSite(await this.getSite())
    const email = (await this.getEmail()).trim()
    if (!base || !email) throw new Error('Jira 사이트/이메일이 설정되지 않았습니다')

    const auth = btoa(`${email}:${token}`)
    const res = await this.fetchFn(`${base}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'sally-alarm',
      },
      body: JSON.stringify({ jql: JQL, fields: ['summary', 'updated'], maxResults: 50 }),
    })

    if (res.status === 401) throw new Error('UNAUTHORIZED')
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> }
        const msgs = [
          ...(body.errorMessages ?? []),
          ...Object.values(body.errors ?? {}),
        ]
        if (msgs.length) detail = ` - ${msgs.join('; ')}`
      } catch {
        // 본문 파싱 실패는 무시
      }
      throw new Error(`Jira API 오류: ${res.status}${detail}`)
    }

    const data = (await res.json()) as { issues?: JiraIssue[] }
    return { items: (data.issues ?? []).map((i) => toItem(i, base)), notModified: false }
  }
}
