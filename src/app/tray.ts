import { TrayIcon } from '@tauri-apps/api/tray'
import { Menu } from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'
import trayIconUrl from '../assets/tray-Template.png'

let created = false

async function loadIconBytes(): Promise<Uint8Array> {
  const res = await fetch(trayIconUrl)
  return new Uint8Array(await res.arrayBuffer())
}

async function showWindow(): Promise<void> {
  const win = getCurrentWindow()
  await win.show()
  await win.setFocus()
}

async function toggleWindow(): Promise<void> {
  const win = getCurrentWindow()
  if (await win.isVisible()) {
    await win.hide()
  } else {
    await showWindow()
  }
}

export async function setupTray(opts: {
  onOpen: () => void
  onQuit: () => void
}): Promise<void> {
  if (created) return
  created = true

  const menu = await Menu.new({
    items: [
      {
        id: 'open',
        text: '알림 열기',
        action: async () => {
          await showWindow()
          opts.onOpen()
        },
      },
      { id: 'quit', text: '종료', action: opts.onQuit },
    ],
  })

  await TrayIcon.new({
    id: 'sally-alarm-tray',
    icon: await loadIconBytes(),
    iconAsTemplate: true,
    menu,
    showMenuOnLeftClick: false,
    tooltip: 'sally-alarm',
    action: async (event) => {
      // Click 이벤트는 누름(Down)·뗌(Up) 두 번 발생하므로 좌클릭 Up에서만 1회 토글한다.
      if (
        event.type === 'Click' &&
        event.button === 'Left' &&
        event.buttonState === 'Up'
      ) {
        const wasVisible = await getCurrentWindow().isVisible()
        await toggleWindow()
        if (!wasVisible) {
          opts.onOpen()
        }
      }
    },
  })
}
