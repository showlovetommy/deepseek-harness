/** Window chrome: menu building and tray wiring with injected Electron surfaces. */

import { describe, expect, it } from 'vitest'
import {
  buildApplicationMenu, wireTray,
  type AppSurface, type MenuSurface, type TrayHandle, type WindowHandle,
} from '../src/window.ts'

/** A recording window handle; minimized starts false. */
function fakeWindow(minimized = false): { handle: WindowHandle; calls: string[]; minimized: boolean } {
  const calls: string[] = []
  const state = { minimized }
  return {
    calls,
    minimized: state.minimized,
    handle: {
      show: () => { calls.push('show') },
      isMinimized: () => { calls.push('isMinimized'); return state.minimized },
      restore: () => { calls.push('restore') },
      focus: () => { calls.push('focus') },
    },
  }
}

function fakeMenu(): { surface: MenuSurface; template: unknown[]; set: unknown[] } {
  const template: unknown[] = []
  const set: unknown[] = []
  return {
    template,
    set,
    surface: {
      buildFromTemplate: (entries) => { template.push(...entries); return { built: true } },
      setApplicationMenu: (menu) => { set.push(menu) },
    },
  }
}

function fakeApp(): { surface: AppSurface; state: { quitCalls: number } } {
  const state = { quitCalls: 0 }
  return {
    state,
    surface: {
      quit: () => { state.quitCalls++ },
      getName: () => 'dsh',
    },
  }
}

describe('buildApplicationMenu', () => {
  it('builds the menu from the template and installs it', () => {
    const menu = fakeMenu()
    const app = fakeApp()
    const win = fakeWindow()
    buildApplicationMenu({ menu: menu.surface, app: app.surface }, win.handle)
    expect(menu.template.length).toBeGreaterThan(0)
    expect(menu.set).toHaveLength(1)
    expect(menu.set[0]).toEqual({ built: true })
  })

  it('wires the Show Main Window item to restore/show/focus', () => {
    const menu = fakeMenu()
    const app = fakeApp()
    const win = fakeWindow(true)
    buildApplicationMenu({ menu: menu.surface, app: app.surface }, win.handle)
    const windowItem = menu.template.find(item =>
      typeof item === 'object' && item !== null && (item as { label?: string }).label === 'Window') as {
      submenu: Array<{ label?: string; click?: () => void }>
    }
    const show = windowItem.submenu.find(item => item.label === 'Show Main Window')
    expect(show?.click).toBeDefined()
    win.calls.length = 0
    show!.click!()
    expect(win.calls).toEqual(['isMinimized', 'restore', 'show', 'focus'])
  })

  it('wires Quit to the app surface', () => {
    const menu = fakeMenu()
    const app = fakeApp()
    const win = fakeWindow()
    buildApplicationMenu({ menu: menu.surface, app: app.surface }, win.handle)
    const quit = menu.template.find(item =>
      typeof item === 'object' && item !== null && (item as { label?: string }).label === 'Quit') as {
      click?: () => void
    }
    quit.click!()
    expect(app.state.quitCalls).toBe(1)
  })
})

describe('wireTray', () => {
  it('skips the tray when no handle is provided', () => {
    const app = fakeApp()
    const win = fakeWindow()
    expect(wireTray(undefined, { menu: fakeMenu().surface, app: app.surface }, win.handle)).toBeUndefined()
  })

  it('wires a tray click to show the window and supports destroy', () => {
    const app = fakeApp()
    const win = fakeWindow(true)
    const clicks: Array<() => void> = []
    let destroyed = false
    let tooltip = ''
    const tray: TrayHandle = {
      setToolTip: (tip) => { tooltip = tip },
      setContextMenu: (_menu) => {},
      on: (_event, listener) => { clicks.push(listener) },
      destroy: () => { destroyed = true },
    }
    const handle = wireTray(tray, { menu: fakeMenu().surface, app: app.surface }, win.handle)
    expect(handle).toBeDefined()
    expect(tooltip).toBe('dsh')
    expect(clicks).toHaveLength(1)
    win.calls.length = 0
    clicks[0]!()
    expect(win.calls).toEqual(['isMinimized', 'restore', 'show', 'focus'])
    handle!.destroy()
    expect(destroyed).toBe(true)
  })
})
