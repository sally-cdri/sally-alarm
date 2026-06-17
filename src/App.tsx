import { useEffect, useState, useCallback, useRef } from 'react'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { exit } from '@tauri-apps/plugin-process'
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
  setIntervalSec as persistIntervalSec,
} from './app/storage'
import { ensureNotifyPermission, notify, open } from './app/notifier'
import { setupTray } from './app/tray'

export default function App() {
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [items, setItems] = useState<NotifItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [intervalSec, setIntervalState] = useState<number>(60)
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
    pollerRef.current = poller
    await poller.init()
    poller.start()
  }, [])

  useEffect(() => {
    void (async () => {
      await ensureNotifyPermission()
      await setupTray({
        onOpen: () => {},
        onQuit: () => { void exit(0) },
      })
      const token = await getToken()
      setHasToken(Boolean(token))
      const savedInterval = await getIntervalSec()
      setIntervalState(savedInterval)
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
    } catch {
      setError('토큰 삭제에 실패했습니다.')
    }
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
            value={intervalSec}
            onChange={(e) => setIntervalState(Number(e.target.value) || 60)}
            onBlur={async (e) => {
              const n = Math.max(30, Number(e.target.value) || 60)
              setIntervalState(n)
              await persistIntervalSec(n)
            }}
          />
        </label>
      </footer>
    </main>
  )
}
