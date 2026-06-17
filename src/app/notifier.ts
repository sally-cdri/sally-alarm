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
