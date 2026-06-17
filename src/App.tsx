import { useEffect, useState, useCallback, useRef } from 'react'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { exit } from '@tauri-apps/plugin-process'
import { GitHubProvider } from './core/github'
import { Poller } from './core/poller'
import type { NotifItem, NotifType } from './core/types'
import {
  getToken,
  saveToken,
  deleteToken,
  loadPollerState,
  savePollerState,
  getIntervalSec,
  setIntervalSec as persistIntervalSec,
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
  return new Date(ts).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Clover({ size = 28 }: { size?: number }) {
  const leaf =
    'M0 0 C -8 -18 -34 -18 -34 -40 C -34 -54 -18 -60 0 -45 C 18 -60 34 -54 34 -40 C 34 -18 8 -18 0 0 Z'
  return (
    <svg
      className="clover"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <g fill="currentColor" transform="translate(50,52)">
        <path transform="rotate(45)" d={leaf} />
        <path transform="rotate(135)" d={leaf} />
        <path transform="rotate(225)" d={leaf} />
        <path transform="rotate(315)" d={leaf} />
      </g>
    </svg>
  )
}

export default function App() {
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [items, setItems] = useState<NotifItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [intervalSec, setIntervalState] = useState<number>(60)
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [connOk, setConnOk] = useState<boolean>(true)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [tab, setTab] = useState<'unread' | 'read'>('unread')
  const pollerRef = useRef<Poller | null>(null)
  const providerRef = useRef<GitHubProvider | null>(null)
  const primedRef = useRef<boolean>(false)

  const startPolling = useCallback(async () => {
    pollerRef.current?.stop()
    const provider = new GitHubProvider(
      () => getToken(),
      (url, init) => tauriFetch(url, { method: init?.method, headers: init?.headers }),
    )
    providerRef.current = provider
    primedRef.current = false
    const sec = await getIntervalSec()
    const poller = new Poller({
      provider,
      intervalSec: sec,
      loadState: loadPollerState,
      saveState: savePollerState,
      onItems: (current) => setItems(current),
      onNew: (fresh) => {
        // 첫 폴링의 기존 알림은 토스트하지 않고, 이후 새로 온 미읽음만 알린다.
        if (primedRef.current) fresh.filter((f) => !f.read).forEach(notify)
      },
      onTick: (ok) => {
        primedRef.current = true
        setLastChecked(Date.now())
        setConnOk(ok)
        setRefreshing(false)
        if (ok) setError(null)
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setError(
          msg === 'UNAUTHORIZED'
            ? '토큰이 만료되었거나 잘못되었습니다. 다시 연결해 주세요.'
            : msg,
        )
      },
    })
    pollerRef.current = poller
    await poller.init()
    poller.start()
  }, [])

  useEffect(() => {
    void (async () => {
      await ensureNotifyPermission()
      await setupTray({
        onOpen: () => {},
        onQuit: () => {
          void exit(0)
        },
      })
      const token = await getToken()
      setHasToken(Boolean(token))
      setIntervalState(await getIntervalSec())
      if (token) await startPolling()
    })()
    return () => {
      pollerRef.current?.stop()
    }
  }, [startPolling])

  async function handleSaveToken() {
    if (!tokenInput.trim()) return
    try {
      await saveToken(tokenInput.trim())
      setTokenInput('')
      setError(null)
      setHasToken(true)
      await startPolling()
    } catch {
      setError('토큰 저장에 실패했습니다.')
    }
  }

  async function handleLogout() {
    try {
      await deleteToken()
      setHasToken(false)
      setItems([])
      setLastChecked(null)
      setError(null)
    } catch {
      setError('토큰 삭제에 실패했습니다.')
    }
  }

  async function handleRefresh() {
    if (!pollerRef.current || refreshing) return
    setRefreshing(true)
    await pollerRef.current.tick()
  }

  async function handleOpen(it: NotifItem) {
    void open(it.url)
    if (!it.read) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, read: true } : x)))
      try {
        await providerRef.current?.markRead(it.id)
      } catch {
        // 읽음 처리 실패는 조용히 무시(다음 폴링에서 동기화됨)
      }
    }
  }

  if (hasToken === null) {
    return (
      <main className="panel panel--center">
        <div className="loading">불러오는 중…</div>
      </main>
    )
  }

  if (!hasToken) {
    return (
      <main className="panel panel--center">
        <div className="onboard">
          <span className="onboard__mark">
            <Clover size={44} />
          </span>
          <h1 className="onboard__title">sally-alarm</h1>
          <p className="onboard__desc">
            GitHub 알림을 메뉴바에서 받아보려면 classic Personal Access Token
            (<code>notifications</code> 권한)을 연결하세요.
          </p>
          <input
            className="field"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSaveToken()
            }}
            placeholder="ghp_…"
            autoFocus
          />
          <button
            className="btn btn--primary btn--block"
            onClick={handleSaveToken}
            disabled={!tokenInput.trim()}
          >
            연결
          </button>
          {error && <p className="error error--inline">{error}</p>}
        </div>
      </main>
    )
  }

  const unreadItems = items.filter((i) => !i.read)
  const readItems = items.filter((i) => i.read)
  const shown = tab === 'unread' ? unreadItems : readItems

  return (
    <main className="panel">
      <header className="topbar">
        <div className="topbar__brand">
          <Clover size={20} />
          <span className="topbar__name">sally-alarm</span>
          {unreadItems.length > 0 && (
            <span className="badge">{unreadItems.length}</span>
          )}
        </div>
        <div className="topbar__actions">
          <button
            className="btn btn--ghost"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? '확인 중…' : '새로고침'}
          </button>
          <button className="btn btn--ghost" onClick={handleLogout}>
            토큰 삭제
          </button>
        </div>
      </header>

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

      {error && <div className="error">{error}</div>}

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
              {lastChecked === null
                ? 'GitHub에서 알림을 가져오고 있어요.'
                : tab === 'unread'
                  ? '새 멘션·리뷰 요청·답글이 오면 여기에 표시됩니다.'
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
              <span className={`tag tag--${it.type}`}>{TYPE_LABEL[it.type]}</span>
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
        <label className="footer__field">
          <span>간격</span>
          <span className="stepper">
            <input
              type="number"
              min={30}
              value={intervalSec}
              onChange={(e) => setIntervalState(Number(e.target.value) || 60)}
              onBlur={async (e) => {
                const n = Math.max(30, Number(e.target.value) || 60)
                setIntervalState(n)
                await persistIntervalSec(n)
              }}
            />
            <span className="stepper__unit">초</span>
          </span>
        </label>
      </footer>
    </main>
  )
}
