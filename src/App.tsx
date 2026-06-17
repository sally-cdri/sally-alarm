import { useEffect, useState, useCallback, useRef } from 'react'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { exit } from '@tauri-apps/plugin-process'
import { GitHubProvider } from './core/github'
import type { FetchFn } from './core/github'
import { NotionProvider, notionPageId } from './core/notion'
import { FigmaProvider, figmaFileKey } from './core/figma'
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
} from './app/storage'
import { ensureNotifyPermission, notify, open } from './app/notifier'
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
  other: '알림',
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  github: 'GitHub',
  notion: 'Notion',
  figma: 'Figma',
  slack: 'Slack',
  jira: 'Jira',
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
    make: (g, t, f) => new FigmaProvider(g, t, f),
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
  const leaf =
    'M0 0 C -8 -18 -34 -18 -34 -40 C -34 -54 -18 -60 0 -45 C 18 -60 34 -54 34 -40 C 34 -18 8 -18 0 0 Z'
  return (
    <svg className="clover" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <g fill="currentColor" transform="translate(50,52)">
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

export default function App() {
  const [ready, setReady] = useState(false)
  const [hasGithub, setHasGithub] = useState(false)
  const [ghInput, setGhInput] = useState('')
  const [ghItems, setGhItems] = useState<NotifItem[]>([])
  const [acc, setAcc] = useState<Record<AccId, AccState>>({
    notion: emptyAcc(),
    figma: emptyAcc(),
  })

  const [error, setError] = useState<string | null>(null)
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [connOk, setConnOk] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<'unread' | 'read'>('unread')
  const [intervalSec, setIntervalState] = useState(60)
  const [showSettings, setShowSettings] = useState(false)

  const ghPoller = useRef<Poller | null>(null)
  const ghProvider = useRef<GitHubProvider | null>(null)
  const ghPrimed = useRef(false)
  const accPollers = useRef<Record<AccId, Poller | null>>({ notion: null, figma: null })
  const accPrimed = useRef<Record<AccId, boolean>>({ notion: false, figma: false })

  const fetchFn: FetchFn = useCallback(
    (url, init) => tauriFetch(url, { method: init?.method, headers: init?.headers }),
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
      const provider = src.make(() => getToken(src.account), src.getTargets, fetchFn)
      const poller = new Poller({
        provider,
        intervalSec: await getIntervalSec(),
        loadState: () => loadPollerState(src.id),
        saveState: (s) => savePollerState(src.id, s),
        onNew: (fresh) => {
          setAcc((prev) => {
            const cur = prev[src.id]
            const ids = new Set(cur.items.map((i) => i.id))
            const add = fresh.filter((f) => !ids.has(f.id))
            return { ...prev, [src.id]: { ...cur, items: [...add, ...cur.items].slice(0, 100) } }
          })
          if (accPrimed.current[src.id]) fresh.forEach(notify)
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

      setIntervalState(await getIntervalSec())
      setShowSettings(!gh && !anyAcc)
      setReady(true)
    })()
    return () => {
      ghPoller.current?.stop()
      accPollers.current.notion?.stop()
      accPollers.current.figma?.stop()
    }
  }, [startGithub, startAcc, patchAcc])

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    await Promise.all([
      ghPoller.current?.tick(),
      accPollers.current.notion?.tick(),
      accPollers.current.figma?.tick(),
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
    const v = Math.max(30, n || 60)
    setIntervalState(v)
    await persistIntervalSec(v)
  }

  if (!ready) {
    return (
      <main className="panel panel--center">
        <div className="loading">불러오는 중…</div>
      </main>
    )
  }

  const anyConnected = hasGithub || ACC_SOURCES.some((s) => acc[s.id].has)
  const items = [...ghItems, ...acc.notion.items, ...acc.figma.items].sort((a, b) =>
    (b.timestamp || '').localeCompare(a.timestamp || ''),
  )
  const unreadItems = items.filter((i) => !i.read)
  const readItems = items.filter((i) => i.read)
  const shown = tab === 'unread' ? unreadItems : readItems

  return (
    <main className="panel">
      <header className="topbar">
        <div className="topbar__brand">
          <Clover size={20} />
          <span className="topbar__name">sally-alarm</span>
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

          <section className="src-card">
            <label className="footer__field">
              <span>폴링 간격</span>
              <span className="stepper">
                <input
                  type="number"
                  min={30}
                  value={intervalSec}
                  onChange={(e) => setIntervalState(Number(e.target.value) || 60)}
                  onBlur={(e) => void changeInterval(Number(e.target.value))}
                />
                <span className="stepper__unit">초</span>
              </span>
            </label>
          </section>
        </div>
      ) : !anyConnected ? (
        <div className="empty">
          <span className="empty__mark">
            <Clover size={40} />
          </span>
          <p className="empty__title">연결된 소스가 없습니다</p>
          <span className="empty__hint">설정에서 GitHub · Notion · Figma를 연결하세요.</span>
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
