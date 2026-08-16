/**
 * Desktop window chrome: application menu, tray, and window lifecycle for the
 * desktop shell. Electron's Menu/Tray surfaces are injected so the wiring is
 * testable without an Electron runtime; the app passes the real ones.
 * @module @deepseek-ai/dsh-desktop/window
 */

/** The slice of electron's Menu this module uses. */
export interface MenuSurface {
  setApplicationMenu(menu: unknown): void
  buildFromTemplate(template: readonly unknown[]): unknown
}

/** A constructed tray instance the chrome wires actions to. */
export interface TrayHandle {
  setToolTip(tooltip: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click', listener: () => void): void
  destroy(): void
}

/** The slice of electron's app this module uses. */
export interface AppSurface {
  quit(): void
  getName(): string
}

/** Electron surfaces the window chrome needs; the app passes the real ones. */
export interface WindowChromeSurfaces {
  menu: MenuSurface
  tray?: TrayHandle
  app: AppSurface
}

/** A window handle the chrome wires menu/tray actions to. */
export interface WindowHandle {
  show(): void
  isMinimized(): boolean
  restore(): void
  focus(): void
}

/**
 * Build the application menu: the standard app menu (macOS) plus Edit and
 * Window roles, and a Quit item wired to the injected app surface.
 * @param surfaces - injected Electron menu/app surfaces.
 * @param window - the window the Window menu acts on.
 * @returns the built menu (for tests: the template entries as passed).
 */
export function buildApplicationMenu(
  surfaces: WindowChromeSurfaces,
  window: WindowHandle,
): unknown {
  const isMac = process.platform === 'darwin'
  const template: unknown[] = [
    ...isMac ? [{ role: 'appMenu' as const }] : [],
    { role: 'fileMenu' as const },
    { role: 'editMenu' as const },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        { type: 'separator' as const },
        { role: 'front' as const },
        {
          label: 'Show Main Window',
          click: () => {
            if (window.isMinimized()) window.restore()
            window.show()
            window.focus()
          },
        },
      ],
    },
    {
      label: 'Quit',
      click: () => { surfaces.app.quit() },
    },
  ]
  const menu = surfaces.menu.buildFromTemplate(template)
  surfaces.menu.setApplicationMenu(menu)
  return menu
}

/**
 * Wire a constructed tray to the window: the app builds the tray (with its
 * icon) and passes the handle; this function adds the tooltip and the
 * show-window click behavior.
 * @param tray - the constructed tray handle (absent skips wiring).
 * @param surfaces - the app surface for the tooltip name.
 * @param window - the window the tray click shows.
 * @returns a disposer that destroys the tray, or undefined when no tray was given.
 */
export function wireTray(
  tray: TrayHandle | undefined,
  surfaces: WindowChromeSurfaces,
  window: WindowHandle,
): { destroy(): void } | undefined {
  if (tray === undefined) return undefined
  tray.setToolTip(surfaces.app.getName())
  tray.on('click', () => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  return {
    destroy: () => { tray.destroy() },
  }
}
