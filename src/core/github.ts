import type {
  NotificationProvider,
  NotifItem,
  NotifType,
  PollOptions,
  PollResult,
  ProviderId,
} from './types'

const KIND_MAP: Record<string, string> = {
  pulls: 'pull',
  issues: 'issues',
  commits: 'commit',
}

export function apiUrlToHtmlUrl(apiUrl: string | null): string {
  if (!apiUrl) return 'https://github.com/notifications'
  const m = apiUrl.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  )
  if (!m) return 'https://github.com/notifications'
  const [, owner, repo, kind, rest] = m
  const webKind = KIND_MAP[kind] ?? kind
  return `https://github.com/${owner}/${repo}/${webKind}/${rest}`
}

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>

interface GitHubThread {
  id: string
  reason: string
  unread: boolean
  updated_at: string
  subject: { title: string; type: string; url: string | null; latest_comment_url?: string | null }
  repository: { full_name: string }
}

function previewOf(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim()
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine
}

// 나와 직접 관련된 reason만 알림으로 받는다.
// subscribed(레포 watch)·ci_activity·state_change·security_alert 등 watch성 노이즈는 제외.
const RELEVANT_REASONS = new Set([
  'mention',
  'team_mention',
  'review_requested',
  'assign',
  'author',
  'comment',
])

function reasonToType(reason: string): NotifType {
  switch (reason) {
    case 'mention':
    case 'team_mention':
      return 'mention'
    case 'review_requested':
      return 'review_request'
    case 'comment':
      return 'reply'
    case 'assign':
      return 'assign'
    case 'author':
      return 'author'
    default:
      return 'other'
  }
}

function toNotifItem(t: GitHubThread): NotifItem {
  return {
    id: t.id,
    provider: 'github',
    title: t.subject.title,
    body: `${t.repository.full_name} · ${t.reason}`,
    url: apiUrlToHtmlUrl(t.subject.url),
    timestamp: t.updated_at,
    type: reasonToType(t.reason),
    read: t.unread === false,
  }
}

export class GitHubProvider implements NotificationProvider {
  readonly id: ProviderId = 'github'

  constructor(
    private getToken: () => Promise<string | null>,
    private fetchFn: FetchFn,
  ) {}

  async poll(opts: PollOptions = {}): Promise<PollResult> {
    const token = await this.getToken()
    if (!token) throw new Error('GitHub PAT가 설정되지 않았습니다')

    const authHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sally-alarm',
    }
    const headers: Record<string, string> = { ...authHeaders }
    if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified

    // all=true: 읽음/미읽음 모두 받아 탭으로 구분한다.
    let url = 'https://api.github.com/notifications?all=true'
    if (opts.since) url += `&since=${encodeURIComponent(opts.since)}`

    const res = await this.fetchFn(url, { method: 'GET', headers })

    const poll = res.headers.get('X-Poll-Interval')
    const pollIntervalSec = poll ? Number(poll) : undefined

    if (res.status === 304) {
      return { items: [], notModified: true, lastModified: opts.lastModified, pollIntervalSec }
    }
    if (res.status === 401) throw new Error('UNAUTHORIZED')
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { message?: string }
        if (body?.message) detail = ` - ${body.message}`
      } catch {
        // 본문 파싱 실패는 무시
      }
      throw new Error(`GitHub API 오류: ${res.status}${detail}`)
    }

    const lastModified = res.headers.get('Last-Modified') ?? undefined
    const all = (await res.json()) as GitHubThread[]
    // 나와 직접 관련된 reason만 남긴다(watch성 알림 제외).
    const raw = all.filter((t) => RELEVANT_REASONS.has(t.reason))
    const items = raw.map(toNotifItem)

    // 미읽음 항목 보강(변경 폴링에서만 도달): 코멘트 미리보기 + PR 요청자/승인 라벨.
    let budget = 15
    for (let i = 0; i < raw.length && budget > 0; i++) {
      const t = raw[i]
      if (t.unread === false) continue
      budget--

      // 최신 코멘트 본문 미리보기
      if (t.subject.latest_comment_url) {
        try {
          const cr = await this.fetchFn(t.subject.latest_comment_url, {
            method: 'GET',
            headers: authHeaders,
          })
          if (cr.ok) {
            const c = (await cr.json()) as { body?: string }
            if (c.body) items[i].preview = previewOf(c.body)
          }
        } catch {
          // 미리보기 조회 실패는 무시
        }
      }

      // PR 전용: 리뷰 요청은 요청자 표시, 그 외 내 PR은 승인 라벨.
      if (t.subject.type === 'PullRequest' && t.subject.url) {
        try {
          if (t.reason === 'review_requested') {
            const pr = await this.fetchFn(t.subject.url, { method: 'GET', headers: authHeaders })
            if (pr.ok) {
              const data = (await pr.json()) as { user?: { login?: string } }
              const login = data.user?.login
              if (login) items[i].body = `${t.repository.full_name} · @${login} 요청`
            }
          } else {
            const rr = await this.fetchFn(`${t.subject.url}/reviews?per_page=100`, {
              method: 'GET',
              headers: authHeaders,
            })
            if (rr.ok) {
              const reviews = (await rr.json()) as { state?: string; submitted_at?: string }[]
              if (Array.isArray(reviews)) {
                const decisive = reviews
                  .filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
                  .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
                if (decisive.length && decisive[decisive.length - 1].state === 'APPROVED') {
                  items[i].type = 'approved'
                }
              }
            }
          }
        } catch {
          // 조회 실패는 무시(표시/라벨만 영향)
        }
      }
    }

    return { items, notModified: false, lastModified, pollIntervalSec }
  }

  /** 알림 thread를 읽음 처리한다(GitHub). 성공/이미 처리됨이면 조용히 반환. */
  async markRead(threadId: string): Promise<void> {
    const token = await this.getToken()
    if (!token) throw new Error('GitHub PAT가 설정되지 않았습니다')
    const res = await this.fetchFn(
      `https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'sally-alarm',
        },
      },
    )
    // 205 Reset Content(성공), 304(이미 읽음) 모두 정상으로 본다.
    if (res.status === 401) throw new Error('UNAUTHORIZED')
    if (!res.ok && res.status !== 205 && res.status !== 304) {
      throw new Error(`읽음 처리 실패: ${res.status}`)
    }
  }
}
