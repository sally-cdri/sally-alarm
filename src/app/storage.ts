import { invoke } from '@tauri-apps/api/core'
import { load, type Store } from '@tauri-apps/plugin-store'
import type { PollerState } from '../core/types'

let storePromise: Promise<Store> | null = null
function store(): Promise<Store> {
  storePromise ??= load('sally-alarm.json', { autoSave: false, defaults: {} })
  return storePromise
}

// 키체인 account 키 (서비스별 토큰)
export const GITHUB_ACCOUNT = 'github-pat'
export const NOTION_ACCOUNT = 'notion-token'
export const FIGMA_ACCOUNT = 'figma-token'

// 키체인 (Rust 커맨드) — account별 토큰 저장
export const saveToken = (account: string, token: string) =>
  invoke<void>('save_token', { account, token })
export const getToken = (account: string) => invoke<string | null>('get_token', { account })
export const deleteToken = (account: string) => invoke<void>('delete_token', { account })

// 소스별 폴러 상태 (plaintext store — 토큰은 절대 넣지 않음)
export async function loadPollerState(key: string): Promise<PollerState> {
  const s = await store()
  return {
    lastModified: (await s.get<string>(`lastModified:${key}`)) ?? undefined,
    seenIds: (await s.get<string[]>(`seenIds:${key}`)) ?? [],
  }
}

export async function savePollerState(key: string, state: PollerState): Promise<void> {
  const s = await store()
  await s.set(`lastModified:${key}`, state.lastModified ?? null)
  await s.set(`seenIds:${key}`, state.seenIds)
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

// Notion 감지 대상 페이지 URL 목록
export async function getNotionPages(): Promise<string[]> {
  const s = await store()
  return (await s.get<string[]>('notionPages')) ?? []
}

export async function setNotionPages(pages: string[]): Promise<void> {
  const s = await store()
  await s.set('notionPages', pages)
  await s.save()
}

// Figma 감지 대상 파일 URL 목록
export async function getFigmaFiles(): Promise<string[]> {
  const s = await store()
  return (await s.get<string[]>('figmaFiles')) ?? []
}

export async function setFigmaFiles(files: string[]): Promise<void> {
  const s = await store()
  await s.set('figmaFiles', files)
  await s.save()
}
