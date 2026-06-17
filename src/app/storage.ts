import { invoke } from '@tauri-apps/api/core'
import { load, type Store } from '@tauri-apps/plugin-store'
import type { PollerState } from '../core/types'

let storePromise: Promise<Store> | null = null
function store(): Promise<Store> {
  storePromise ??= load('sally-alarm.json', { autoSave: false, defaults: {} })
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
