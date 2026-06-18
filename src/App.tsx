import { useEffect, useState, useCallback, useRef } from 'react'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { exit } from '@tauri-apps/plugin-process'
import { GitHubProvider } from './core/github'
import type { FetchFn } from './core/github'
import { NotionProvider, notionPageId } from './core/notion'
import { FigmaProvider, figmaFileKey } from './core/figma'
import { JiraProvider } from './core/jira'
import { ConfluenceProvider } from './core/confluence'
import { Poller } from './core/poller'
import type { NotificationProvider, NotifItem, NotifType, ProviderId } from './core/types'
import {
  GITHUB_ACCOUNT,
  NOTION_ACCOUNT,
  FIGMA_ACCOUNT,
  getToken,
  saveToken,
  deleteToken,
  loadPollerState,
  savePollerState,
  getIntervalSec,
  setIntervalSec as persistIntervalSec,
  getNotionPages,
  setNotionPages as persistNotionPages,
  getFigmaFiles,
  setFigmaFiles as persistFigmaFiles,
  JIRA_ACCOUNT,
  getJiraSite,
  setJiraSite as persistJiraSite,
  getJiraEmail,
  setJiraEmail as persistJiraEmail,
  getMentionName,
  setMentionName as persistMentionName,
  getUserName,
  setUserName as persistUserName,
  getConfluenceEnabled,
  setConfluenceEnabled as persistConfluenceEnabled,
} from './app/storage'
import { ensureNotifyPermission, notify, open } from './app/notifier'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { setupTray } from './app/tray'
import '@fontsource/noto-sans-kr/400.css'
import '@fontsource/noto-sans-kr/500.css'
import '@fontsource/noto-sans-kr/700.css'
import './App.css'

const TYPE_LABEL: Record<NotifType, string> = {
  mention: '멘션',
  review_request: '리뷰 요청',
  review: '리뷰',
  reply: '답글',
  assign: '할당',
  author: '내 PR/이슈',
  approved: '승인됨',
  other: '알림',
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  github: 'GitHub',
  notion: 'Notion',
  figma: 'Figma',
  slack: 'Slack',
  jira: 'Jira',
  confluence: 'Confluence',
}

// 토큰 + 지정 대상(링크) + 새 항목 누적 패턴의 소스 (Notion, Figma)
type AccId = 'notion' | 'figma'
interface AccSource {
  id: AccId
  account: string
  tokenPlaceholder: string
  targetPlaceholder: string
  targetLabel: string
  hint: string
  getTargets: () => Promise<string[]>
  setTargets: (v: string[]) => Promise<void>
  validate: (s: string) => boolean
  // true면 첫 폴링을 조용히 기준선 처리(이후 새 것만). false면 첫 폴링부터 현재 항목 전부 표시.
  seedSilently: boolean
  make: (
    getTok: () => Promise<string | null>,
    getTargets: () => Promise<string[]>,
    ff: FetchFn,
  ) => NotificationProvider
}

const ACC_SOURCES: AccSource[] = [
  {
    id: 'notion',
    account: NOTION_ACCOUNT,
    tokenPlaceholder: 'secret_… / ntn_…',
    targetPlaceholder: 'https://www.notion.so/…',
    targetLabel: '감지할 페이지 링크 (수정되면 알림)',
    hint: 'internal integration 토큰을 입력하고, 감지할 페이지를 그 integration에 공유하세요.',
    getTargets: getNotionPages,
    setTargets: persistNotionPages,
    validate: (s) => notionPageId(s) !== null,
    seedSilently: true,
    make: (g, t, f) => new NotionProvider(g, t, f),
  },
  {
    id: 'figma',
    account: FIGMA_ACCOUNT,
    tokenPlaceholder: 'figd_…',
    targetPlaceholder: 'https://www.figma.com/file/…',
    targetLabel: '감지할 파일 링크 (새 댓글 알림)',
    hint: 'figma.com → Settings → personal access token을 발급해 입력하세요. 파일에 접근 권한이 있어야 합니다.',
    getTargets: getFigmaFiles,
    setTargets: persistFigmaFiles,
    validate: (s) => figmaFileKey(s) !== null,
    seedSilently: false,
    make: (g, t, f) => new FigmaProvider(g, t, f, getMentionName),
  },
]

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m === 'UNAUTHORIZED'
    ? '토큰이 만료되었거나 잘못되었습니다. 설정에서 다시 연결해 주세요.'
    : m
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

function clockOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

function Clover({ size = 28 }: { size?: number }) {
  // 앱 아이콘(assets/appicon.svg)과 동일한 네잎클로버 지오메트리
  const leaf =
    'M0 0 C -40 -88 -170 -88 -170 -200 C -170 -272 -90 -300 0 -226 C 90 -300 170 -272 170 -200 C 170 -88 40 -88 0 0 Z'
  return (
    <svg className="clover" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      {/* 줄기: 중앙 하단에서 오른쪽으로 휘어짐 */}
      <path
        d="M512 520 Q 500 700 600 800"
        stroke="currentColor"
        strokeWidth={34}
        fill="none"
        strokeLinecap="round"
      />
      {/* 네 잎: 하트를 대각선(45°)으로 4개 */}
      <g fill="currentColor" transform="translate(512,500)">
        <path transform="rotate(45)" d={leaf} />
        <path transform="rotate(135)" d={leaf} />
        <path transform="rotate(225)" d={leaf} />
        <path transform="rotate(315)" d={leaf} />
      </g>
    </svg>
  )
}

interface AccState {
  has: boolean
  targets: string[]
  items: NotifItem[]
  tokenInput: string
  targetInput: string
}

const emptyAcc = (): AccState => ({
  has: false,
  targets: [],
  items: [],
  tokenInput: '',
  targetInput: '',
})

function NameGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = () => {
    const n = name.trim()
    if (n) onSubmit(n)
  }
  return (
    <main className="panel panel--center onboarding">
      <div className="onboarding__box">
        <Clover size={48} />
        <h2 className="onboarding__title">환영합니다</h2>
        <p className="onboarding__desc">앱에 표시할 이름을 입력해 주세요.</p>
        <input
          autoFocus
          className="onboarding__input"
          placeholder="이름"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="btn btn--primary btn--block" disabled={!name.trim()} onClick={submit}>
          시작하기
        </button>
      </div>
    </main>
  )
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [hasGithub, setHasGithub] = useState(false)
  const [ghInput, setGhInput] = useState('')
  const [ghItems, setGhItems] = useState<NotifItem[]>([])
  const [acc, setAcc] = useState<Record<AccId, AccState>>({
    notion: emptyAcc(),
    figma: emptyAcc(),
  })
  const [jira, setJira] = useState({
    has: false,
    items: [] as NotifItem[],
    tokenInput: '',
    siteInput: '',
    emailInput: '',
  })
  const [mentionName, setMentionState] = useState('')
  const [userName, setUserNameState] = useState('')
  const [confluenceOn, setConfluenceOn] = useState(false)
  const [confItems, setConfItems] = useState<NotifItem[]>([])

  const [error, setError] = useState<string | null>(null)
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [connOk, setConnOk] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<'unread' | 'read'>('unread')
  const [intervalSec, setIntervalState] = useState(10)
  const [showSettings, setShowSettings] = useState(false)

  const ghPoller = useRef<Poller | null>(null)
  const ghProvider = useRef<GitHubProvider | null>(null)
  const ghPrimed = useRef(false)
  const accPollers = useRef<Record<AccId, Poller | null>>({ notion: null, figma: null })
  const accPrimed = useRef<Record<AccId, boolean>>({ notion: false, figma: false })
  const accHadHistory = useRef<Record<AccId, boolean>>({ notion: false, figma: false })
  const jiraPoller = useRef<Poller | null>(null)
  const jiraPrimed = useRef(false)
  const jiraHadHistory = useRef(false)
  const confPoller = useRef<Poller | null>(null)
  const confPrimed = useRef(false)
  const confHadHistory = useRef(false)

  const fetchFn: FetchFn = useCallback(
    (url, init) =>
      tauriFetch(url, { method: init?.method, headers: init?.headers, body: init?.body }),
    [],
  )

  const markChecked = useCallback((ok: boolean) => {
    setLastChecked(Date.now())
    setConnOk(ok)
    setRefreshing(false)
    if (ok) setError(null)
  }, [])

  const patchAcc = useCallback((id: AccId, p: Partial<AccState>) => {
    setAcc((s) => ({ ...s, [id]: { ...s[id], ...p } }))
  }, [])

  const startGithub = useCallback(async () => {
    ghPoller.current?.stop()
    ghPrimed.current = false
    const provider = new GitHubProvider(() => getToken(GITHUB_ACCOUNT), fetchFn)
    ghProvider.current = provider
    const poller = new Poller({
      provider,
      intervalSec: await getIntervalSec(),
      loadState: () => loadPollerState('github'),
      saveState: (s) => savePollerState('github', s),
      onItems: (cur) => setGhItems(cur),
      onNew: (fresh) => {
        if (ghPrimed.current) fresh.filter((f) => !f.read).forEach(notify)
      },
      onTick: (ok) => {
        ghPrimed.current = true
        markChecked(ok)
      },
      onError: (e) => setError(errMsg(e)),
    })
    ghPoller.current = poller
    await poller.init()
    poller.start()
  }, [fetchFn, markChecked])

  const startAcc = useCallback(
    async (src: AccSource) => {
      accPollers.current[src.id]?.stop()
      accPrimed.current[src.id] = false
      accHadHistory.current[src.id] = (await loadPollerState(src.id)).seenIds.length > 0
      const provider = src.make(() => getToken(src.account), src.getTargets, fetchFn)
      const poller = new Poller({
        provider,
        intervalSec: await getIntervalSec(),
        loadState: () => loadPollerState(src.id),
        saveState: (s) => savePollerState(src.id, s),
        onNew: (fresh) => {
          const primed = accPrimed.current[src.id]
          // seedSilently인 소스만: 최초 연결의 첫 폴링은 기준선으로 조용히 시드(목록/토스트 없음).
          // Figma처럼 false면 첫 폴링부터 현재(오늘) 항목을 전부 목록에 표시(토스트만 억제).
          if (!primed && src.seedSilently && !accHadHistory.current[src.id]) return
          setAcc((prev) => {
            const cur = prev[src.id]
            const ids = new Set(cur.items.map((i) => i.id))
            const add = fresh.filter((f) => !ids.has(f.id))
            return { ...prev, [src.id]: { ...cur, items: [...add, ...cur.items].slice(0, 100) } }
          })
          if (primed) fresh.forEach(notify) // 첫 폴링 토스트 폭주 방지
        },
        onTick: (ok) => {
          accPrimed.current[src.id] = true
          markChecked(ok)
        },
        onError: (e) => setError(errMsg(e)),
      })
      accPollers.current[src.id] = poller
      await poller.init()
      poller.start()
    },
    [fetchFn, markChecked],
  )

  const startJira = useCallback(async () => {
    jiraPoller.current?.stop()
    jiraPrimed.current = false
    jiraHadHistory.current = (await loadPollerState('jira')).seenIds.length > 0
    const provider = new JiraProvider(
      () => getToken(JIRA_ACCOUNT),
      getJiraSite,
      getJiraEmail,
      fetchFn,
    )
    const poller = new Poller({
      provider,
      intervalSec: await getIntervalSec(),
      loadState: () => loadPollerState('jira'),
      saveState: (s) => savePollerState('jira', s),
      onNew: (fresh) => {
        const primed = jiraPrimed.current
        if (!primed && !jiraHadHistory.current) return
        setJira((prev) => {
          const ids = new Set(prev.items.map((i) => i.id))
          const add = fresh.filter((f) => !ids.has(f.id))
          return { ...prev, items: [...add, ...prev.items].slice(0, 100) }
        })
        if (primed) fresh.forEach(notify)
      },
      onTick: (ok) => {
        jiraPrimed.current = true
        markChecked(ok)
      },
      onError: (e) => setError(errMsg(e)),
    })
    jiraPoller.current = poller
    await poller.init()
    poller.start()
  }, [fetchFn, markChecked])

  const startConfluence = useCallback(async () => {
    confPoller.current?.stop()
    confPrimed.current = false
    confHadHistory.current = (await loadPollerState('confluence')).seenIds.length > 0
    const provider = new ConfluenceProvider(
      () => getToken(JIRA_ACCOUNT),
      getJiraSite,
      getJiraEmail,
      fetchFn,
    )
    const poller = new Poller({
      provider,
      intervalSec: await getIntervalSec(),
      loadState: () => loadPollerState('confluence'),
      saveState: (s) => savePollerState('confluence', s),
      onNew: (fresh) => {
        const primed = confPrimed.current
        if (!primed && !confHadHistory.current) return
        setConfItems((prev) => {
          const ids = new Set(prev.map((i) => i.id))
          const add = fresh.filter((f) => !ids.has(f.id))
          return [...add, ...prev].slice(0, 100)
        })
        if (primed) fresh.forEach(notify)
      },
      onTick: (ok) => {
        confPrimed.current = true
        markChecked(ok)
      },
      onError: (e) => setError(errMsg(e)),
    })
    confPoller.current = poller
    await poller.init()
    poller.start()
  }, [fetchFn, markChecked])

  useEffect(() => {
    void (async () => {
      await ensureNotifyPermission()
      await setupTray({ onOpen: () => {}, onQuit: () => void exit(0) })

      const gh = await getToken(GITHUB_ACCOUNT)
      setHasGithub(Boolean(gh))
      if (gh) await startGithub()

      let anyAcc = false
      for (const src of ACC_SOURCES) {
        const [tok, targets] = await Promise.all([getToken(src.account), src.getTargets()])
        patchAcc(src.id, { has: Boolean(tok), targets })
        if (tok) anyAcc = true
        if (tok && targets.length) await startAcc(src)
      }

      const [jtok, jsite, jemail] = await Promise.all([
        getToken(JIRA_ACCOUNT),
        getJiraSite(),
        getJiraEmail(),
      ])
      setJira((prev) => ({ ...prev, has: Boolean(jtok) }))
      if (jtok && jsite && jemail) await startJira()

      const confOn = await getConfluenceEnabled()
      setConfluenceOn(confOn)
      if (jtok && jsite && jemail && confOn) await startConfluence()

      setMentionState(await getMentionName())
      setUserNameState(await getUserName())
      setIntervalState(await getIntervalSec())
      setShowSettings(!gh && !anyAcc && !jtok)
      setReady(true)
    })()
    return () => {
      ghPoller.current?.stop()
      accPollers.current.notion?.stop()
      accPollers.current.figma?.stop()
      jiraPoller.current?.stop()
      confPoller.current?.stop()
    }
  }, [startGithub, startAcc, startJira, startConfluence, patchAcc])

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    await Promise.all([
      ghPoller.current?.tick(),
      accPollers.current.notion?.tick(),
      accPollers.current.figma?.tick(),
      jiraPoller.current?.tick(),
      confPoller.current?.tick(),
    ])
    setRefreshing(false)
  }

  async function handleOpen(it: NotifItem) {
    void open(it.url)
    if (it.read) return
    if (it.provider === 'github') {
      setGhItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, read: true } : x)))
      try {
        await ghProvider.current?.markRead(it.id)
      } catch {
        // 다음 폴링에서 동기화
      }
    } else if (it.provider === 'notion' || it.provider === 'figma') {
      const id = it.provider
      setAcc((prev) => ({
        ...prev,
        [id]: { ...prev[id], items: prev[id].items.map((x) => (x.id === it.id ? { ...x, read: true } : x)) },
      }))
    } else if (it.provider === 'jira') {
      setJira((prev) => ({
        ...prev,
        items: prev.items.map((x) => (x.id === it.id ? { ...x, read: true } : x)),
      }))
    } else if (it.provider === 'confluence') {
      setConfItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, read: true } : x)))
    }
  }

  // --- 설정 동작 ---
  async function connectGithub() {
    if (!ghInput.trim()) return
    await saveToken(GITHUB_ACCOUNT, ghInput.trim())
    setGhInput('')
    setHasGithub(true)
    await startGithub()
  }
  async function disconnectGithub() {
    await deleteToken(GITHUB_ACCOUNT)
    ghPoller.current?.stop()
    setHasGithub(false)
    setGhItems([])
  }
  async function connectAcc(src: AccSource) {
    const tok = acc[src.id].tokenInput.trim()
    if (!tok) return
    await saveToken(src.account, tok)
    patchAcc(src.id, { has: true, tokenInput: '' })
    if (acc[src.id].targets.length) await startAcc(src)
  }
  async function disconnectAcc(src: AccSource) {
    await deleteToken(src.account)
    accPollers.current[src.id]?.stop()
    patchAcc(src.id, { has: false, items: [] })
  }
  async function addTarget(src: AccSource) {
    const url = acc[src.id].targetInput.trim()
    if (!url || !src.validate(url)) {
      setError('유효한 링크가 아닙니다.')
      return
    }
    const next = [...acc[src.id].targets, url]
    patchAcc(src.id, { targets: next, targetInput: '' })
    setError(null)
    await src.setTargets(next)
    if (acc[src.id].has) await startAcc(src)
  }
  async function removeTarget(src: AccSource, url: string) {
    const next = acc[src.id].targets.filter((p) => p !== url)
    patchAcc(src.id, { targets: next })
    await src.setTargets(next)
    if (acc[src.id].has) await startAcc(src)
  }
  async function changeInterval(n: number) {
    const v = Math.max(5, n || 10)
    setIntervalState(v)
    await persistIntervalSec(v)
  }
  async function connectJira() {
    const tok = jira.tokenInput.trim()
    const site = jira.siteInput.trim()
    const email = jira.emailInput.trim()
    if (!tok || !site || !email) return
    await saveToken(JIRA_ACCOUNT, tok)
    await persistJiraSite(site)
    await persistJiraEmail(email)
    setJira((prev) => ({ ...prev, has: true, tokenInput: '', siteInput: '', emailInput: '' }))
    await startJira()
    if (confluenceOn) await startConfluence()
  }
  async function disconnectJira() {
    await deleteToken(JIRA_ACCOUNT)
    jiraPoller.current?.stop()
    confPoller.current?.stop()
    setJira((prev) => ({ ...prev, has: false, items: [] }))
    setConfItems([])
  }
  async function toggleConfluence(on: boolean) {
    setConfluenceOn(on)
    await persistConfluenceEnabled(on)
    if (on && jira.has) {
      await startConfluence()
    } else {
      confPoller.current?.stop()
      setConfItems([])
    }
  }
  async function changeMention(v: string) {
    setMentionState(v)
    await persistMentionName(v)
  }
  async function testNotify() {
    try {
      let granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
      if (!granted) {
        setError('진단: 알림 권한 = 거부됨. 시스템 설정 → 알림 → SallyAlarm에서 "알림 허용"을 켜주세요.')
        return
      }
      await sendNotification({ title: 'SallyAlarm 테스트', body: '알림 동작 확인' })
      setError(
        '진단: 권한=허용, 전송 완료. 배너가 안 보이면 ① 집중모드(Focus) 켜짐 ② 알림 스타일 "없음" ③ ad-hoc 서명 문제일 수 있어요.',
      )
    } catch (e) {
      setError('진단: 테스트 알림 오류 — ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (!ready) {
    return (
      <main className="panel panel--center">
        <div className="loading">불러오는 중…</div>
      </main>
    )
  }

  const anyConnected = hasGithub || ACC_SOURCES.some((s) => acc[s.id].has) || jira.has
  const items = [
    ...ghItems,
    ...acc.notion.items,
    ...acc.figma.items,
    ...jira.items,
    ...confItems,
  ].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
  const unreadItems = items.filter((i) => !i.read)
  const readItems = items.filter((i) => i.read)
  const shown = tab === 'unread' ? unreadItems : readItems

  // 첫 실행: 사용자 이름을 입력받기 전에는 이름 입력 화면을 보여준다.
  if (ready && !userName) {
    return (
      <NameGate
        onSubmit={(name) => {
          void persistUserName(name).then(() => setUserNameState(name))
        }}
      />
    )
  }

  return (
    <main className="panel">
      <header className="topbar">
        <div className="topbar__brand">
          <Clover size={20} />
          <span className="topbar__name">{userName}</span>
          {unreadItems.length > 0 && <span className="badge">{unreadItems.length}</span>}
        </div>
        <div className="topbar__actions">
          {!showSettings && anyConnected && (
            <button className="btn btn--ghost" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? '확인 중…' : '새로고침'}
            </button>
          )}
          <button
            className={`btn btn--ghost ${showSettings ? 'is-active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
          >
            {showSettings ? '닫기' : '설정'}
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {showSettings ? (
        <div className="settings">
          {/* GitHub */}
          <section className="src-card">
            <div className="src-card__head">
              <span className="src src--github">GitHub</span>
              <span className={`src-card__state ${hasGithub ? 'is-on' : ''}`}>
                {hasGithub ? '연결됨' : '연결 안 됨'}
              </span>
            </div>
            {hasGithub ? (
              <button className="btn btn--ghost" onClick={disconnectGithub}>
                연결 해제
              </button>
            ) : (
              <>
                <p className="src-card__hint">
                  classic PAT(<code>notifications</code> 권한)을 입력하세요.
                </p>
                <div className="row">
                  <input
                    className="field"
                    type="password"
                    value={ghInput}
                    onChange={(e) => setGhInput(e.target.value)}
                    placeholder="ghp_…"
                  />
                  <button className="btn btn--primary" onClick={connectGithub} disabled={!ghInput.trim()}>
                    연결
                  </button>
                </div>
              </>
            )}
          </section>

          {/* Notion / Figma */}
          {ACC_SOURCES.map((src) => {
            const st = acc[src.id]
            return (
              <section className="src-card" key={src.id}>
                <div className="src-card__head">
                  <span className={`src src--${src.id}`}>{PROVIDER_LABEL[src.id]}</span>
                  <span className={`src-card__state ${st.has ? 'is-on' : ''}`}>
                    {st.has ? '연결됨' : '연결 안 됨'}
                  </span>
                </div>
                {src.id === 'figma' && (
                  <div className="mention">
                    <p className="src-card__hint">
                      내 이름(멘션 필터) — 이 이름이 포함된 댓글만 알림. 비우면 모든 새 댓글.
                    </p>
                    <input
                      className="field"
                      type="text"
                      value={mentionName}
                      onChange={(e) => void changeMention(e.target.value)}
                      placeholder="예: sally"
                    />
                  </div>
                )}
                {st.has ? (
                  <button className="btn btn--ghost" onClick={() => disconnectAcc(src)}>
                    연결 해제
                  </button>
                ) : (
                  <>
                    <p className="src-card__hint">{src.hint}</p>
                    <div className="row">
                      <input
                        className="field"
                        type="password"
                        value={st.tokenInput}
                        onChange={(e) => patchAcc(src.id, { tokenInput: e.target.value })}
                        placeholder={src.tokenPlaceholder}
                      />
                      <button
                        className="btn btn--primary"
                        onClick={() => connectAcc(src)}
                        disabled={!st.tokenInput.trim()}
                      >
                        연결
                      </button>
                    </div>
                  </>
                )}

                <div className="pages">
                  <p className="src-card__hint">{src.targetLabel}</p>
                  <div className="row">
                    <input
                      className="field"
                      type="text"
                      value={st.targetInput}
                      onChange={(e) => patchAcc(src.id, { targetInput: e.target.value })}
                      placeholder={src.targetPlaceholder}
                    />
                    <button
                      className="btn btn--primary"
                      onClick={() => addTarget(src)}
                      disabled={!st.targetInput.trim()}
                    >
                      추가
                    </button>
                  </div>
                  {st.targets.length === 0 ? (
                    <p className="pages__empty">등록된 링크가 없습니다.</p>
                  ) : (
                    <ul className="pages__list">
                      {st.targets.map((p) => (
                        <li key={p} className="pages__item">
                          <span className="pages__url">{p}</span>
                          <button className="pages__remove" onClick={() => removeTarget(src, p)}>
                            삭제
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )
          })}

          {/* Jira */}
          <section className="src-card">
            <div className="src-card__head">
              <span className="src src--jira">Jira</span>
              <span className={`src-card__state ${jira.has ? 'is-on' : ''}`}>
                {jira.has ? '연결됨' : '연결 안 됨'}
              </span>
            </div>
            {jira.has ? (
              <button className="btn btn--ghost" onClick={disconnectJira}>
                연결 해제
              </button>
            ) : (
              <>
                <p className="src-card__hint">
                  사이트 주소 · 이메일 · API 토큰(id.atlassian.com에서 발급)을 입력하세요. 내가
                  담당/보고/관찰하는 이슈의 최근 변경을 알림으로 줍니다.
                </p>
                <input
                  className="field"
                  type="text"
                  value={jira.siteInput}
                  onChange={(e) => setJira((p) => ({ ...p, siteInput: e.target.value }))}
                  placeholder="회사이름 또는 회사.atlassian.net"
                />
                <input
                  className="field"
                  type="text"
                  value={jira.emailInput}
                  onChange={(e) => setJira((p) => ({ ...p, emailInput: e.target.value }))}
                  placeholder="me@company.com"
                />
                <div className="row">
                  <input
                    className="field"
                    type="password"
                    value={jira.tokenInput}
                    onChange={(e) => setJira((p) => ({ ...p, tokenInput: e.target.value }))}
                    placeholder="API token"
                  />
                  <button
                    className="btn btn--primary"
                    onClick={connectJira}
                    disabled={!jira.tokenInput.trim() || !jira.siteInput.trim() || !jira.emailInput.trim()}
                  >
                    연결
                  </button>
                </div>
              </>
            )}
            <label className="conf-toggle">
              <input
                type="checkbox"
                checked={confluenceOn}
                onChange={(e) => void toggleConfluence(e.target.checked)}
              />
              <span>Confluence 페이지 변경도 감지 (같은 Atlassian 계정)</span>
            </label>
          </section>

          <section className="src-card">
            <label className="footer__field">
              <span>폴링 간격</span>
              <span className="stepper">
                <input
                  type="number"
                  min={5}
                  value={intervalSec}
                  onChange={(e) => setIntervalState(Number(e.target.value) || 60)}
                  onBlur={(e) => void changeInterval(Number(e.target.value))}
                />
                <span className="stepper__unit">초</span>
              </span>
            </label>
            <button className="btn btn--ghost" onClick={testNotify}>
              테스트 알림 보내기
            </button>
          </section>
        </div>
      ) : !anyConnected ? (
        <div className="empty">
          <span className="empty__mark">
            <Clover size={40} />
          </span>
          <p className="empty__title">연결된 소스가 없습니다</p>
          <span className="empty__hint">설정에서 GitHub · Notion · Figma · Jira를 연결하세요.</span>
          <button className="btn btn--primary" onClick={() => setShowSettings(true)}>
            설정 열기
          </button>
        </div>
      ) : (
        <>
          <nav className="tabs">
            <button
              className={`tab ${tab === 'unread' ? 'is-active' : ''}`}
              onClick={() => setTab('unread')}
            >
              읽지 않음
              {unreadItems.length > 0 && <span className="tab__count">{unreadItems.length}</span>}
            </button>
            <button
              className={`tab ${tab === 'read' ? 'is-active' : ''}`}
              onClick={() => setTab('read')}
            >
              읽음
            </button>
          </nav>

          <div className="list">
            {shown.length === 0 ? (
              <div className="empty">
                <span className="empty__mark">
                  <Clover size={40} />
                </span>
                <p className="empty__title">
                  {lastChecked === null
                    ? '확인하는 중…'
                    : tab === 'unread'
                      ? '읽지 않은 알림이 없습니다'
                      : '읽은 알림이 없습니다'}
                </p>
                <span className="empty__hint">
                  {tab === 'unread'
                    ? '새 알림이 오면 여기에 표시됩니다.'
                    : '알림을 클릭하면 읽음 처리되어 이곳으로 옮겨집니다.'}
                </span>
              </div>
            ) : (
              shown.map((it) => (
                <button
                  key={it.id}
                  className={`card ${it.read ? 'is-read' : ''}`}
                  onClick={() => handleOpen(it)}
                >
                  <span className="card__tags">
                    <span className={`src src--${it.provider}`}>{PROVIDER_LABEL[it.provider]}</span>
                    <span className={`tag tag--${it.type}`}>{TYPE_LABEL[it.type]}</span>
                  </span>
                  <span className="card__title">{it.title}</span>
                  {it.preview && <span className="card__preview">{it.preview}</span>}
                  <span className="card__meta">
                    <span className="card__repo">{it.body}</span>
                    <span className="card__time">{timeAgo(it.timestamp)}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          <footer className="footer">
            <span className="status">
              <span className={`status__dot ${connOk ? 'is-ok' : 'is-err'}`} />
              {lastChecked === null
                ? '확인 대기 중'
                : connOk
                  ? `${clockOf(lastChecked)} 확인됨`
                  : '연결 오류'}
            </span>
          </footer>
        </>
      )}
    </main>
  )
}
