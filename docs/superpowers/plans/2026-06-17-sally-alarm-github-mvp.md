# sally-alarm (GitHub 알림 메뉴바 앱) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub에서 나에게 온 알림(멘션·리뷰요청·내 PR 답글 등)을 macOS 메뉴바에서 폴링해 네이티브 토스트로 띄우고, 드롭다운 패널에서 목록을 보고 클릭해 브라우저로 여는 Tauri 앱을 만든다.

**Architecture:** UI(React/TS)와 순수 Core(TS: Provider 인터페이스, GitHubProvider, 중복제거, 폴링 스케줄러)를 분리한다. Core는 GitHub API를 주입받은 `fetch`로 호출하므로 mock으로 단위 테스트한다. 네이티브 기능(트레이, 토스트, 키체인)은 Tauri 플러그인 + 최소 Rust로 처리하고 빌드/수동 확인한다.

**Tech Stack:** Tauri v2, React + TypeScript + Vite, Vitest, Rust `keyring` 4(`apple-native`), Tauri 플러그인 notification/http/store/opener.

## Global Constraints

- Tauri **v2**. 플러그인/커맨드 등록과 Rust 코드는 `src-tauri/src/lib.rs`의 `run()` 빌더에 작성한다 (`main.rs` 아님).
- TS에서 Rust 커맨드 호출은 `invoke`를 `@tauri-apps/api/core`에서 import한다 (`/tauri` 아님).
- 권한은 v2 capabilities 시스템(`src-tauri/capabilities/default.json`)으로 부여한다.
- GitHub 인증은 **PAT**, 헤더는 `Authorization: Bearer <PAT>` + `Accept: application/vnd.github+json` + `User-Agent`.
- PAT은 **macOS 키체인에만** 저장한다. 평문 파일/스토어에 토큰을 쓰지 않는다.
- keyring 크레이트는 v4: feature `apple-native`, 삭제는 `delete_credential()`.
- 커밋 메시지에 Claude 작성 표기를 넣지 않는다. UI 문구·로그·커밋에 이모지를 쓰지 않고 한글/일반 텍스트를 쓴다.
- DRY / YAGNI / TDD / 잦은 커밋.

## File Structure

```
sally-alarm/
  src/
    core/
      types.ts              # NotifItem, NotificationProvider, PollResult, PollerState 등 타입
      github.ts             # apiUrlToHtmlUrl, GitHubProvider
      github.test.ts
      dedup.ts              # filterNew
      dedup.test.ts
      poller.ts             # Poller (tick/start/stop)
      poller.test.ts
    app/
      storage.ts            # store 플러그인 래퍼 + 키체인 invoke 래퍼
      notifier.ts           # 알림 권한 + sendNotification + openUrl 래퍼
      tray.ts               # 트레이 아이콘/메뉴 생성
    ui/
      App.tsx               # 메뉴바 패널 UI (토큰 입력/목록/설정)
    main.tsx                # 부트스트랩: 권한→토큰→provider→poller→tray
  src-tauri/
    src/lib.rs              # 플러그인 등록 + 키체인 커맨드 + Accessory 정책
    Cargo.toml
    capabilities/default.json
    tauri.conf.json
```

---

### Task 1: 프로젝트 스캐폴딩 + 테스트 러너

**Files:**
- Create: 전체 Tauri 프로젝트 (스캐폴딩)
- Modify: `package.json` (test 스크립트), `vite.config.ts`
- Create: `src/core/smoke.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: 동작하는 Tauri v2 React-TS 프로젝트, `npm test`로 Vitest 실행 가능

- [ ] **Step 1: 프로젝트 생성**

`/Users/sally`에서 실행 (이미 만든 `sally-alarm` 폴더와 합치기 위해 임시 이름으로 생성 후 내용 이동):

```bash
cd /Users/sally
npm create tauri-app@latest sally-alarm-app -- --template react-ts --manager npm
# 프롬프트가 남으면: identifier = com.sally.alarm
rsync -a sally-alarm-app/ sally-alarm/
rm -rf sally-alarm-app
cd sally-alarm
npm install
```

기존 `docs/`와 `.git`은 `sally-alarm`에 그대로 유지된다.

- [ ] **Step 2: Vitest 설치 및 스크립트 추가**

```bash
cd /Users/sally/sally-alarm
npm install -D vitest
```

`package.json`의 `scripts`에 추가:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: 스모크 테스트 작성**

`src/core/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('테스트 러너가 동작한다', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test`
Expected: PASS (1 passed)

- [ ] **Step 5: dev 실행으로 앱이 뜨는지 확인 (수동)**

Run: `npm run tauri dev`
Expected: 기본 Tauri 창이 뜬다. 확인 후 종료.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "chore: Tauri v2 React-TS 스캐폴딩 + vitest 설정"
```

---

### Task 2: Core 타입 + GitHub URL 변환 (순수 함수)

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/github.ts`
- Test: `src/core/github.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `types.ts`: `ProviderId`, `NotifType`, `NotifItem`, `PollOptions`, `PollResult`, `NotificationProvider`, `PollerState`
  - `github.ts`: `apiUrlToHtmlUrl(apiUrl: string | null): string`

- [ ] **Step 1: 타입 정의 작성**

`src/core/types.ts`:

```ts
export type ProviderId = 'github' | 'slack' | 'jira' | 'notion'

export type NotifType =
  | 'mention'
  | 'review'
  | 'reply'
  | 'review_request'
  | 'assign'
  | 'other'

export interface NotifItem {
  id: string
  provider: ProviderId
  title: string
  body: string
  url: string // 브라우저에서 열 URL
  timestamp: string // ISO 8601
  type: NotifType
}

export interface PollOptions {
  since?: string
  lastModified?: string
}

export interface PollResult {
  items: NotifItem[]
  notModified: boolean
  lastModified?: string
  pollIntervalSec?: number
}

export interface NotificationProvider {
  readonly id: ProviderId
  poll(opts?: PollOptions): Promise<PollResult>
}

export interface PollerState {
  lastModified?: string
  seenIds: string[]
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/core/github.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { apiUrlToHtmlUrl } from './github'

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
})
```

- [ ] **Step 3: 테스트 실행해서 실패 확인**

Run: `npm test -- github`
Expected: FAIL ("apiUrlToHtmlUrl is not a function" 또는 import 오류)

- [ ] **Step 4: 최소 구현 작성**

`src/core/github.ts`:

```ts
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
```

- [ ] **Step 5: 테스트 실행해서 통과 확인**

Run: `npm test -- github`
Expected: PASS (4 passed)

- [ ] **Step 6: 커밋**

```bash
git add src/core/types.ts src/core/github.ts src/core/github.test.ts
git commit -m "feat: core 타입 및 GitHub API→web URL 변환 추가"
```

---

### Task 3: GitHubProvider.poll (mock fetch로 TDD)

**Files:**
- Modify: `src/core/github.ts`
- Test: `src/core/github.test.ts`

**Interfaces:**
- Consumes: `apiUrlToHtmlUrl`, `types.ts`의 `NotificationProvider`/`PollResult`/`PollOptions`/`NotifItem`/`NotifType`
- Produces:
  - `type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<Response>`
  - `class GitHubProvider implements NotificationProvider`, 생성자 `(getToken: () => Promise<string | null>, fetchFn: FetchFn)`

- [ ] **Step 1: 실패하는 테스트 작성 (github.test.ts에 추가)**

```ts
import { GitHubProvider } from './github'
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
    })
    expect(res.lastModified).toBe('Wed, 17 Jun 2026 12:00:00 GMT')
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
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npm test -- github`
Expected: FAIL ("GitHubProvider is not a constructor")

- [ ] **Step 3: 구현 추가 (github.ts에 append)**

```ts
import type {
  NotificationProvider,
  NotifItem,
  NotifType,
  PollOptions,
  PollResult,
  ProviderId,
} from './types'

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>

interface GitHubThread {
  id: string
  reason: string
  updated_at: string
  subject: { title: string; type: string; url: string | null }
  repository: { full_name: string }
}

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

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sally-alarm',
    }
    if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified

    let url = 'https://api.github.com/notifications'
    if (opts.since) url += `?since=${encodeURIComponent(opts.since)}`

    const res = await this.fetchFn(url, { method: 'GET', headers })

    const poll = res.headers.get('X-Poll-Interval')
    const pollIntervalSec = poll ? Number(poll) : undefined

    if (res.status === 304) {
      return { items: [], notModified: true, lastModified: opts.lastModified, pollIntervalSec }
    }
    if (res.status === 401) throw new Error('UNAUTHORIZED')
    if (!res.ok) throw new Error(`GitHub API 오류: ${res.status}`)

    const lastModified = res.headers.get('Last-Modified') ?? undefined
    const raw = (await res.json()) as GitHubThread[]
    return { items: raw.map(toNotifItem), notModified: false, lastModified, pollIntervalSec }
  }
}
```

`github.ts` 맨 위의 import에 `apiUrlToHtmlUrl`이 같은 파일에 있으므로 import 불필요. `types.ts` import만 추가.

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test -- github`
Expected: PASS (이전 4 + 신규 5 = 9 passed)

- [ ] **Step 5: 커밋**

```bash
git add src/core/github.ts src/core/github.test.ts
git commit -m "feat: GitHubProvider 폴링 구현 (304/401/매핑 처리)"
```

---

### Task 4: 중복제거 filterNew (순수 함수)

**Files:**
- Create: `src/core/dedup.ts`
- Test: `src/core/dedup.test.ts`

**Interfaces:**
- Consumes: `types.ts`의 `NotifItem`
- Produces: `filterNew(items: NotifItem[], seenIds: Set<string>): NotifItem[]`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/dedup.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterNew } from './dedup'
import type { NotifItem } from './types'

function item(id: string): NotifItem {
  return {
    id,
    provider: 'github',
    title: id,
    body: '',
    url: '',
    timestamp: '2026-06-17T00:00:00Z',
    type: 'other',
  }
}

describe('filterNew', () => {
  it('seen에 없는 항목만 반환한다', () => {
    const result = filterNew([item('1'), item('2'), item('3')], new Set(['2']))
    expect(result.map((i) => i.id)).toEqual(['1', '3'])
  })

  it('전부 seen이면 빈 배열', () => {
    expect(filterNew([item('1')], new Set(['1']))).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npm test -- dedup`
Expected: FAIL ("filterNew is not a function")

- [ ] **Step 3: 최소 구현 작성**

`src/core/dedup.ts`:

```ts
import type { NotifItem } from './types'

export function filterNew(items: NotifItem[], seenIds: Set<string>): NotifItem[] {
  return items.filter((i) => !seenIds.has(i.id))
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test -- dedup`
Expected: PASS (2 passed)

- [ ] **Step 5: 커밋**

```bash
git add src/core/dedup.ts src/core/dedup.test.ts
git commit -m "feat: 알림 중복제거 filterNew 추가"
```

---

### Task 5: Poller 스케줄러 (tick TDD)

**Files:**
- Create: `src/core/poller.ts`
- Test: `src/core/poller.test.ts`

**Interfaces:**
- Consumes: `NotificationProvider`, `NotifItem`, `PollerState` (types.ts), `filterNew` (dedup.ts)
- Produces:
  - `interface PollerDeps { provider: NotificationProvider; onNew: (items: NotifItem[]) => void; onError?: (e: unknown) => void; loadState: () => Promise<PollerState>; saveState: (s: PollerState) => Promise<void>; intervalSec: number }`
  - `class Poller`, 메서드 `init(): Promise<void>`, `tick(): Promise<void>`, `start(): void`, `stop(): void`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/poller.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Poller } from './poller'
import type { PollerDeps } from './poller'
import type { NotifItem, PollResult, PollerState } from './types'

function item(id: string): NotifItem {
  return { id, provider: 'github', title: id, body: '', url: '', timestamp: '', type: 'other' }
}

function makeDeps(results: PollResult[]): { deps: PollerDeps; saved: PollerState[]; onNew: ReturnType<typeof vi.fn> } {
  let i = 0
  const saved: PollerState[] = []
  const onNew = vi.fn()
  const deps: PollerDeps = {
    provider: { id: 'github', poll: async () => results[Math.min(i++, results.length - 1)] },
    onNew,
    loadState: async () => ({ seenIds: [] }),
    saveState: async (s) => { saved.push(s) },
    intervalSec: 60,
  }
  return { deps, saved, onNew }
}

describe('Poller.tick', () => {
  it('새 항목만 onNew로 전달하고 상태를 저장한다', async () => {
    const { deps, saved, onNew } = makeDeps([
      { items: [item('1'), item('2')], notModified: false, lastModified: 'LM1' },
    ])
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    expect(onNew).toHaveBeenCalledWith([item('1'), item('2')])
    expect(saved.at(-1)?.lastModified).toBe('LM1')
    expect(saved.at(-1)?.seenIds.sort()).toEqual(['1', '2'])
  })

  it('이미 본 항목은 두번째 tick에서 onNew 안함', async () => {
    const { deps, onNew } = makeDeps([
      { items: [item('1')], notModified: false },
      { items: [item('1')], notModified: false },
    ])
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    await poller.tick()
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('notModified면 onNew를 부르지 않는다', async () => {
    const { deps, onNew } = makeDeps([{ items: [], notModified: true }])
    const poller = new Poller(deps)
    await poller.init()
    await poller.tick()
    expect(onNew).not.toHaveBeenCalled()
  })

  it('poll이 에러를 던지면 onError로 전달하고 throw하지 않는다', async () => {
    const onError = vi.fn()
    const deps: PollerDeps = {
      provider: { id: 'github', poll: async () => { throw new Error('boom') } },
      onNew: vi.fn(),
      onError,
      loadState: async () => ({ seenIds: [] }),
      saveState: async () => {},
      intervalSec: 60,
    }
    const poller = new Poller(deps)
    await poller.init()
    await expect(poller.tick()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npm test -- poller`
Expected: FAIL ("Poller is not a constructor")

- [ ] **Step 3: 구현 작성**

`src/core/poller.ts`:

```ts
import type { NotificationProvider, NotifItem, PollerState } from './types'
import { filterNew } from './dedup'

export interface PollerDeps {
  provider: NotificationProvider
  onNew: (items: NotifItem[]) => void
  onError?: (e: unknown) => void
  loadState: () => Promise<PollerState>
  saveState: (s: PollerState) => Promise<void>
  intervalSec: number
}

const MAX_SEEN = 500

export class Poller {
  private seen = new Set<string>()
  private lastModified?: string
  private timer?: ReturnType<typeof setInterval>

  constructor(private deps: PollerDeps) {}

  async init(): Promise<void> {
    const s = await this.deps.loadState()
    this.lastModified = s.lastModified
    this.seen = new Set(s.seenIds)
  }

  async tick(): Promise<void> {
    try {
      const res = await this.deps.provider.poll({ lastModified: this.lastModified })
      if (res.notModified) return
      if (res.lastModified) this.lastModified = res.lastModified

      const fresh = filterNew(res.items, this.seen)
      if (fresh.length > 0) {
        fresh.forEach((i) => this.seen.add(i.id))
        // seen 무한 증가 방지
        if (this.seen.size > MAX_SEEN) {
          this.seen = new Set([...this.seen].slice(-MAX_SEEN))
        }
        this.deps.onNew(fresh)
      }
      await this.deps.saveState({ lastModified: this.lastModified, seenIds: [...this.seen] })
    } catch (e) {
      this.deps.onError?.(e)
    }
  }

  start(): void {
    this.stop()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalSec * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test -- poller`
Expected: PASS (4 passed)

- [ ] **Step 5: 전체 테스트 확인 후 커밋**

```bash
npm test
git add src/core/poller.ts src/core/poller.test.ts
git commit -m "feat: 폴링 스케줄러 Poller 추가 (tick/start/stop)"
```

---

### Task 6: 키체인 Rust 커맨드 + 플러그인 등록

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: 없음
- Produces: Rust 커맨드 `save_token(token: String)`, `get_token() -> Option<String>`, `delete_token()`. macOS 키체인 service=`com.sally.alarm`, account=`github-pat`.

- [ ] **Step 1: 플러그인 추가 (Cargo/lib.rs/capabilities 자동 편집)**

```bash
cd /Users/sally/sally-alarm
npm run tauri add notification
npm run tauri add http
npm run tauri add store
npm run tauri add opener
```

- [ ] **Step 2: keyring 크레이트 + tray 기능 추가**

`src-tauri/Cargo.toml`의 `[dependencies]`에서 `tauri` 줄에 `tray-icon` feature를 추가하고 keyring을 더한다:

```toml
tauri = { version = "2", features = ["tray-icon", "image-png"] }
keyring = { version = "4", features = ["apple-native"] }
```

- [ ] **Step 3: 키체인 커맨드 작성 + 등록 + 도크 숨김**

`src-tauri/src/lib.rs`를 열어 `run()` 빌더에 반영한다. 키체인 커맨드와 setup, invoke_handler 추가:

```rust
use keyring::Entry;

const KEYCHAIN_SERVICE: &str = "com.sally.alarm";
const KEYCHAIN_USER: &str = "github-pat";

#[tauri::command]
fn save_token(token: String) -> Result<(), String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| e.to_string())?
        .set_password(&token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_token() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

빌더 본문(이미 `tauri add`가 `.plugin(...)`들을 추가해 둔 상태)에 `setup`과 `invoke_handler`를 추가한다. 예시 형태:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
        #[cfg(target_os = "macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![save_token, get_token, delete_token])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

(이미 있는 `.plugin(...)` 줄은 그대로 두고 `.setup`/`.invoke_handler`만 추가. `app`이 `&mut App`이 아닌 클로저 인자명과 충돌하지 않게 기존 setup이 있으면 그 안에 정책 줄을 넣는다.)

- [ ] **Step 4: capabilities에 http 스코프 확인/추가**

`src-tauri/capabilities/default.json`의 `permissions` 배열에 다음이 포함되도록 한다 (`tauri add`가 기본 항목은 추가했음; http는 GitHub 스코프를 명시):

```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "store:default",
    "notification:default",
    {
      "identifier": "http:default",
      "allow": [{ "url": "https://api.github.com/*" }]
    }
  ]
}
```

- [ ] **Step 5: 빌드 확인 (수동)**

Run: `npm run tauri dev`
Expected: 컴파일 성공, 도크 아이콘 없이 실행됨(메뉴바 전용). 콘솔에 키체인/플러그인 관련 에러 없음. 확인 후 종료.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat: 키체인 토큰 커맨드 + Tauri 플러그인 등록 + 메뉴바 전용 설정"
```

---

### Task 7: storage / notifier 래퍼

**Files:**
- Create: `src/app/storage.ts`
- Create: `src/app/notifier.ts`

**Interfaces:**
- Consumes: `PollerState` (types.ts), `NotifItem` (types.ts), Rust 커맨드 `save_token`/`get_token`/`delete_token`
- Produces:
  - `storage.ts`: `getToken()`, `saveToken(t)`, `deleteToken()`, `loadPollerState()`, `savePollerState(s)`, `getIntervalSec()`, `setIntervalSec(n)`
  - `notifier.ts`: `ensureNotifyPermission(): Promise<boolean>`, `notify(item: NotifItem): void`, `open(url: string): Promise<void>`

- [ ] **Step 1: storage.ts 작성**

`src/app/storage.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { load, type Store } from '@tauri-apps/plugin-store'
import type { PollerState } from '../core/types'

let storePromise: Promise<Store> | null = null
function store(): Promise<Store> {
  storePromise ??= load('sally-alarm.json', { autoSave: false })
  return storePromise
}

// 키체인 (Rust 커맨드)
export const saveToken = (token: string) => invoke<void>('save_token', { token })
export const getToken = () => invoke<string | null>('get_token')
export const deleteToken = () => invoke<void>('delete_token')

// 설정/상태 (plaintext store — 토큰은 절대 넣지 않음)
export async function loadPollerState(): Promise<PollerState> {
  const s = await store()
  return {
    lastModified: (await s.get<string>('lastModified')) ?? undefined,
    seenIds: (await s.get<string[]>('seenIds')) ?? [],
  }
}

export async function savePollerState(state: PollerState): Promise<void> {
  const s = await store()
  await s.set('lastModified', state.lastModified ?? null)
  await s.set('seenIds', state.seenIds)
  await s.save()
}

export async function getIntervalSec(): Promise<number> {
  const s = await store()
  return (await s.get<number>('intervalSec')) ?? 60
}

export async function setIntervalSec(n: number): Promise<void> {
  const s = await store()
  await s.set('intervalSec', n)
  await s.save()
}
```

- [ ] **Step 2: notifier.ts 작성**

`src/app/notifier.ts`:

```ts
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { NotifItem } from '../core/types'

export async function ensureNotifyPermission(): Promise<boolean> {
  let granted = await isPermissionGranted()
  if (!granted) granted = (await requestPermission()) === 'granted'
  return granted
}

export function notify(item: NotifItem): void {
  sendNotification({ title: item.title, body: item.body })
}

export function open(url: string): Promise<void> {
  return openUrl(url)
}
```

- [ ] **Step 3: 타입체크 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음 (이 두 파일 관련). 미사용 import 경고가 있으면 정리.

- [ ] **Step 4: 커밋**

```bash
git add src/app/storage.ts src/app/notifier.ts
git commit -m "feat: 키체인/스토어 storage 래퍼 및 알림 notifier 래퍼 추가"
```

---

### Task 8: 트레이 아이콘 + 메뉴

**Files:**
- Create: `src/app/tray.ts`

**Interfaces:**
- Consumes: 없음 (Tauri JS API)
- Produces: `setupTray(opts: { onOpen: () => void; onQuit: () => void }): Promise<void>`

- [ ] **Step 1: tray.ts 작성**

`src/app/tray.ts`:

```ts
import { TrayIcon } from '@tauri-apps/api/tray'
import { Menu } from '@tauri-apps/api/menu'
import { defaultWindowIcon } from '@tauri-apps/api/app'
import { getCurrentWindow } from '@tauri-apps/api/window'

let created = false

export async function setupTray(opts: {
  onOpen: () => void
  onQuit: () => void
}): Promise<void> {
  if (created) return
  created = true

  const menu = await Menu.new({
    items: [
      { id: 'open', text: '알림 열기', action: opts.onOpen },
      { id: 'quit', text: '종료', action: opts.onQuit },
    ],
  })

  await TrayIcon.new({
    id: 'sally-alarm-tray',
    icon: (await defaultWindowIcon()) ?? undefined,
    menu,
    menuOnLeftClick: false,
    tooltip: 'sally-alarm',
    action: (event) => {
      if (event.type === 'click') {
        const win = getCurrentWindow()
        void win.show()
        void win.setFocus()
        opts.onOpen()
      }
    },
  })
}
```

- [ ] **Step 2: 타입체크 확인**

Run: `npx tsc --noEmit`
Expected: tray.ts 관련 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add src/app/tray.ts
git commit -m "feat: 메뉴바 트레이 아이콘 및 메뉴 구성"
```

---

### Task 9: UI 패널 + 부트스트랩 통합

**Files:**
- Modify: `src/App.tsx` (또는 `src/ui/App.tsx`로 이동)
- Modify: `src/main.tsx`
- Create: `src/ui/App.css` (선택)

**Interfaces:**
- Consumes: `GitHubProvider` (core/github), `Poller` (core/poller), `storage.ts` 전부, `notifier.ts` 전부, `setupTray` (app/tray), `fetch` (`@tauri-apps/plugin-http`), `NotifItem`
- Produces: 토큰 미설정 시 PAT 입력 화면, 설정 시 알림 목록 + 폴링 간격 설정 + "모두 읽음" 버튼을 보여주는 앱

- [ ] **Step 1: App 컴포넌트 작성**

`src/App.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { GitHubProvider } from './core/github'
import { Poller } from './core/poller'
import type { NotifItem } from './core/types'
import {
  getToken,
  saveToken,
  deleteToken,
  loadPollerState,
  savePollerState,
  getIntervalSec,
  setIntervalSec,
} from './app/storage'
import { ensureNotifyPermission, notify, open } from './app/notifier'
import { setupTray } from './app/tray'

export default function App() {
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [items, setItems] = useState<NotifItem[]>([])
  const [error, setError] = useState<string | null>(null)

  const startPolling = useCallback(async () => {
    const provider = new GitHubProvider(
      () => getToken(),
      (url, init) => tauriFetch(url, init),
    )
    const intervalSec = await getIntervalSec()
    const poller = new Poller({
      provider,
      intervalSec,
      loadState: loadPollerState,
      saveState: savePollerState,
      onNew: (fresh) => {
        setItems((prev) => [...fresh, ...prev].slice(0, 100))
        fresh.forEach(notify)
        setError(null)
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg === 'UNAUTHORIZED' ? '토큰이 만료되었거나 잘못되었습니다. 다시 입력해 주세요.' : msg)
      },
    })
    await poller.init()
    poller.start()
  }, [])

  useEffect(() => {
    void (async () => {
      await ensureNotifyPermission()
      await setupTray({
        onOpen: () => {},
        onQuit: () => window.close(),
      })
      const token = await getToken()
      setHasToken(Boolean(token))
      if (token) await startPolling()
    })()
  }, [startPolling])

  async function handleSaveToken() {
    if (!tokenInput.trim()) return
    await saveToken(tokenInput.trim())
    setTokenInput('')
    setHasToken(true)
    await startPolling()
  }

  async function handleLogout() {
    await deleteToken()
    setHasToken(false)
    setItems([])
  }

  if (hasToken === null) return <main className="panel">불러오는 중...</main>

  if (!hasToken) {
    return (
      <main className="panel">
        <h2>GitHub 토큰 입력</h2>
        <p>notifications 권한이 있는 Personal Access Token을 붙여넣으세요.</p>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="ghp_..."
        />
        <button onClick={handleSaveToken}>저장</button>
      </main>
    )
  }

  return (
    <main className="panel">
      <header>
        <strong>알림 {items.length}건</strong>
        <span>
          <button onClick={() => setItems([])}>모두 읽음</button>
          <button onClick={handleLogout}>토큰 삭제</button>
        </span>
      </header>
      {error && <p className="error">{error}</p>}
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            <button onClick={() => open(it.url)}>
              <span className="title">{it.title}</span>
              <span className="meta">{it.body}</span>
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="empty">새 알림이 없습니다.</li>}
      </ul>
      <footer>
        <label>
          폴링 간격(초)
          <input
            type="number"
            min={30}
            defaultValue={60}
            onBlur={async (e) => {
              const n = Math.max(30, Number(e.target.value) || 60)
              await setIntervalSec(n)
            }}
          />
        </label>
      </footer>
    </main>
  )
}
```

- [ ] **Step 2: main.tsx 확인**

`src/main.tsx`가 `App`을 `./App`에서 import하는지 확인. 스캐폴딩 기본값이면 그대로 둔다.

- [ ] **Step 3: 타입체크 + 단위 테스트**

Run: `npx tsc --noEmit && npm test`
Expected: 타입 에러 없음, 모든 단위 테스트 PASS.

- [ ] **Step 4: dev 실행 — 토큰 입력 → 알림 흐름 (수동)**

Run: `npm run tauri dev`
수동 확인:
1. 첫 실행 시 토큰 입력 화면이 보인다.
2. 유효한 PAT(notifications scope) 입력 후 저장 → 목록 화면 전환.
3. 메뉴바에 트레이 아이콘이 보이고 도크에는 없다.
4. 실제 GitHub 알림이 있으면 목록에 뜨고 클릭 시 브라우저로 열린다.
5. 새 알림 발생 시(테스트 리포에서 본인 멘션 등) 네이티브 토스트가 뜬다.
6. 앱 재시작 후에도 토큰이 유지된다(키체인).

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat: 알림 패널 UI 및 부트스트랩 통합 (토큰 입력/목록/폴링)"
```

---

### Task 10: 마무리 — README + 빌드 확인

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 없음
- Produces: 실행/빌드 방법 문서

- [ ] **Step 1: README 작성**

`README.md`:

```markdown
# sally-alarm

GitHub 알림을 macOS 메뉴바에서 받아보는 개인용 데스크톱 앱.

## 개발 실행
\`\`\`bash
npm install
npm run tauri dev
\`\`\`

## 테스트
\`\`\`bash
npm test
\`\`\`

## 빌드
\`\`\`bash
npm run tauri build
\`\`\`

## 토큰
GitHub Settings → Developer settings → Personal access tokens 에서
`notifications` (classic) 또는 Notifications 읽기 권한(fine-grained) 토큰을 발급해
앱 첫 화면에 입력한다. 토큰은 macOS 키체인에 저장된다.
```

- [ ] **Step 2: 프로덕션 빌드 확인 (수동)**

Run: `npm run tauri build`
Expected: 빌드 성공, `.app` 산출물 생성.

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs: README 추가 (실행/빌드/토큰 안내)"
```

---

## Self-Review

**Spec coverage:**
- GitHub 멘션/리뷰/PR 답글 폴링 → Task 3 (reason 매핑) ✓
- PAT 인증 → Task 6(키체인 커맨드), Task 7(storage), Task 9(입력 UI) ✓
- 메뉴바 상주 + 네이티브 토스트 → Task 6(Accessory), Task 7(notifier), Task 8(tray) ✓
- 60초 폴링 + If-Modified-Since/백오프 토대 → Task 3(304/X-Poll-Interval), Task 5(Poller) ✓
- 키체인 저장(평문 금지) → Task 6/7 ✓
- 로컬 중복제거(역동기화 없음) → Task 4/5 ✓
- 클릭 시 브라우저 열기 → Task 7(open), Task 9 ✓
- Provider 인터페이스 확장성 → Task 2(types), Task 3(GitHubProvider implements) ✓

**Placeholder scan:** 모든 코드 단계에 실제 코드 포함. TBD/TODO 없음.

**Type consistency:** `NotificationProvider.poll(opts?)`, `PollResult`, `PollerState`, `FetchFn`, `PollerDeps`가 Task 2/3/5/7/9에서 동일 시그니처로 사용됨. `getToken`은 `() => Promise<string | null>`로 일관. tauri `fetch`는 `FetchFn`과 호환되도록 Task 9에서 `(url, init) => tauriFetch(url, init)`로 래핑.

**알려진 한계(의도적):** X-Poll-Interval은 Task 3에서 노출만 하고 Poller가 동적 적용하진 않음(MVP는 고정 간격). 토스트 클릭으로 URL 열기는 MVP 제외(패널 클릭으로 대체).
