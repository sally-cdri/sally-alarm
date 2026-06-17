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
  const pollerRef = useRef<Poller | null>(null)

  const startPolling = useCallback(async () => {
    pollerRef.current?.stop()
    const provider = new GitHubProvider(
      () => getToken(),
      (url, init) => tauriFetch(url, { method: init?.method, headers: init?.headers }),
    )
    const sec = await getIntervalSec()
    const poller = new Poller({
      provider,
      intervalSec: sec,
      loadState: loadPollerState,
      saveState: savePollerState,
      onItems: (current) => setItems(current),
      onNew: (fresh) => fresh.forEach(notify),
      onTick: (ok) => {
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

  return (
    <main className="panel">
      <header className="topbar">
        <div className="topbar__brand">
          <Clover size={20} />
          <span className="topbar__name">sally-alarm</span>
          {items.length > 0 && <span className="badge">{items.length}</span>}
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

      {error && <div className="error">{error}</div>}

      <div className="list">
        {items.length === 0 ? (
          <div className="empty">
            <span className="empty__mark">
              <Clover size={40} />
            </span>
            <p className="empty__title">
              {lastChecked === null ? '확인하는 중…' : '읽지 않은 알림이 없습니다'}
            </p>
            <span className="empty__hint">
              {lastChecked === null
                ? 'GitHub에서 알림을 가져오고 있어요.'
                : 'GitHub에서 읽지 않은 알림만 표시됩니다. GitHub에서 읽음 처리하면 여기서도 사라져요.'}
            </span>
          </div>
        ) : (
          items.map((it) => (
            <button key={it.id} className="card" onClick={() => open(it.url)}>
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
