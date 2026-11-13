import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { patchConfig } from '../../../src/core/config/save.ts'
import { CONFIG_WATCH_DEBOUNCE_MS, ConfigWatcher, watchConfigFile } from '../../../src/core/config/watch.ts'
import type { ConfigChangedEvent, Disposable } from '../../../src/core/config/watch.ts'
import { writeFileAtomic } from '../../../src/core/store/atomic.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

interface Received {
  ev: ConfigChangedEvent
  at: number
}

const live: Disposable[] = []
afterEach(() => {
  for (const d of live.splice(0)) d.dispose()
})

function collector(): {
  got: Received[]
  onChange: (ev: ConfigChangedEvent) => void
  next: (n: number) => Promise<void>
} {
  const got: Received[] = []
  return {
    got,
    onChange: (ev) => got.push({ ev, at: Date.now() }),
    /** Wait until `n` events arrived (fails after 5 s). */
    next: async (n) => {
      const until = Date.now() + 5000
      while (got.length < n) {
        if (Date.now() > until) throw new Error(`expected ${n} config-changed events, got ${got.length}`)
        await sleep(20)
      }
    },
  }
}

describe('config watcher', () => {
  it('fires once, debounced, after a burst of atomic rename-saves', async () => {
    const file = join(home(), 'dimfactory.json')
    await writeFile(file, '{}\n')
    const c = collector()
    live.push(await watchConfigFile({ scope: 'user', path: file }, c.onChange))
    let lastWrite = 0
    for (let i = 0; i < 3; i++) {
      await writeFileAtomic(file, `{ "storage": { "keepRuns": ${100 + i} } }\n`)
      lastWrite = Date.now()
      await sleep(10)
    }
    await c.next(1)
    await sleep(CONFIG_WATCH_DEBOUNCE_MS * 2)
    expect(c.got.map((g) => g.ev)).toEqual([{ scope: 'user' }])
    expect((c.got[0]?.at ?? 0) - lastWrite).toBeGreaterThanOrEqual(CONFIG_WATCH_DEBOUNCE_MS - 15)
  })

  it('keeps watching across repeated saves (re-armed after each rename)', async () => {
    const file = join(home(), 'dimfactory.json')
    await writeFile(file, '{}\n')
    const c = collector()
    const w = new ConfigWatcher(c.onChange, { debounceMs: 60 })
    live.push(w)
    await w.add({ scope: 'user', path: file })
    for (const [i, profile] of ['fast', 'thorough', 'balanced'].entries()) {
      await patchConfig({
        home: home(),
        scope: 'user',
        ops: [{ op: 'replace', path: '/profile', value: profile }],
      })
      await c.next(i + 1)
    }
    expect(c.got).toHaveLength(3)
  })

  it('picks up a project file created together with its .dimfactory/ folder', async () => {
    const folder = join(home(), 'proj')
    await mkdir(folder)
    const c = collector()
    live.push(
      await watchConfigFile(
        { scope: 'project', folder, path: join(folder, '.dimfactory', 'dimfactory.json') },
        c.onChange,
        { debounceMs: 60 },
      ),
    )
    await patchConfig({
      home: home(),
      folderScope: { scopeRoot: folder, folderKey: '0011223344556677' },
      scope: 'project',
      folder,
      ops: [{ op: 'replace', path: '/profile', value: 'fast' }],
    })
    await c.next(1)
    expect(c.got[0]?.ev).toEqual({ scope: 'project', folder })
  })

  it('poll mode notices saves without holding the folder: it can still be renamed (Windows)', async () => {
    const folder = join(home(), 'proj')
    const file = join(folder, '.dimfactory', 'dimfactory.json')
    await mkdir(join(folder, '.dimfactory'), { recursive: true })
    await writeFile(file, '{}\n')
    const c = collector()
    const w = new ConfigWatcher(c.onChange, { debounceMs: 30 })
    live.push(w)
    await w.add({ scope: 'project', folder, path: file, pollMs: 40 })
    await writeFileAtomic(file, '{ "auto": false }\n')
    await c.next(1)
    expect(c.got[0]?.ev).toEqual({ scope: 'project', folder })
    // A directory watch would make this EPERM on Windows while the watch is armed.
    await rename(folder, `${folder}-renamed`)
    await rename(`${folder}-renamed`, folder)
    await sleep(150)
    const seen = c.got.length
    await writeFileAtomic(file, '{ "auto": true }\n')
    await c.next(seen + 1)
    w.dispose()
    const total = c.got.length
    await writeFileAtomic(file, '{}\n')
    await sleep(200)
    expect(c.got).toHaveLength(total)
  })

  it('ignores other files, rewrites with identical content, and stops after dispose', async () => {
    const file = join(home(), 'dimfactory.json')
    await writeFile(file, '{}\n')
    const c = collector()
    const w = await watchConfigFile({ scope: 'user', path: file }, c.onChange, { debounceMs: 60 })
    await writeFile(join(home(), 'other.json'), '{}')
    await writeFileAtomic(file, '{}\n')
    await sleep(400)
    expect(c.got).toEqual([])
    w.dispose()
    await writeFileAtomic(file, '{ "auto": false }\n')
    await sleep(400)
    expect(c.got).toEqual([])
  })
})
