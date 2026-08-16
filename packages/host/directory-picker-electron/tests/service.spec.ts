/** Electron dialog backend: capability kind, pick semantics, cancellation. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ElectronDirectoryPicker, {
  pickElectronDirectory,
  type ElectronDialogSurface,
} from '../src/index.ts'

/** A scripted dialog surface. */
function fakeDialog(results: Array<{ canceled: boolean; filePaths: string[] }>): {
  surface: ElectronDialogSurface
  calls: { title: string; properties: string[] }[]
} {
  const calls: { title: string; properties: string[] }[] = []
  let index = 0
  return {
    calls,
    surface: {
      showOpenDialog: async (options) => {
        calls.push({ title: options.title, properties: options.properties })
        return results[Math.min(index++, results.length - 1)] ?? { canceled: true, filePaths: [] }
      },
    },
  }
}

describe('pickElectronDirectory', () => {
  it('opens the directory chooser and returns the picked path', async () => {
    const fake = fakeDialog([{ canceled: false, filePaths: ['/work/project'] }])
    const path = await pickElectronDirectory(new AbortController().signal, { dialog: fake.surface })
    expect(path).toBe('/work/project')
    expect(fake.calls).toEqual([{
      title: 'Select Workspace Directory',
      properties: ['openDirectory', 'createDirectory'],
    }])
  })

  it('returns null on cancellation and on an empty result', async () => {
    const canceled = fakeDialog([{ canceled: true, filePaths: [] }])
    expect(await pickElectronDirectory(new AbortController().signal, { dialog: canceled.surface })).toBeNull()
    const empty = fakeDialog([{ canceled: false, filePaths: [] }])
    expect(await pickElectronDirectory(new AbortController().signal, { dialog: empty.surface })).toBeNull()
  })
})

describe('ElectronDirectoryPicker', () => {
  it('registers the native capability with a stable object', async () => {
    const ctx = new Context()
    const service = new ElectronDirectoryPicker(ctx)
    const capability = service.capability()
    expect(capability.kind).toBe('native')
    expect(service.capability()).toBe(capability)
  })
})
