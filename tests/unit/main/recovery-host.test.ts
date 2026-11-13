// The host half of recovery.execute (src/main/recovery-host.ts; executors): main writes a shell_copy
// command to the system clipboard and opens an open_docs link before the renderer hears the result; core only
// answers what to copy or open. Tested with a fake Electron clipboard, through the real router and request schemas.
import { describe, expect, it, vi } from 'vitest'
import { applyRecoveryResult, withRecoveryHost } from '../../../src/main/recovery-host.ts'
import type { CoreInvoke, RecoveryHostDeps } from '../../../src/main/recovery-host.ts'
import { createRouter } from '../../../src/main/router.ts'
import { allowedExternalUrl as mainAllowed } from '../../../src/main/urls.ts'
import { EXTERNAL_HOSTS as MAIN_HOSTS } from '../../../src/main/constants.ts'
import { makeEnvelope } from '../../../src/preload/wire.ts'
import { EXTERNAL_HOSTS, allowedExternalUrl } from '../../../src/shared/external-links.ts'
import { parseRequest } from '../../../src/shared/ipc-schemas.ts'
import type { Cmd, RecoveryResult, Result } from '../../../src/shared/ipc.ts'

/** A fake Electron clipboard: what writeText received, in order. */
function fakeClipboard(o: { fail?: boolean } = {}) {
  const written: string[] = []
  return {
    written,
    writeText: (text: string): void => {
      if (o.fail === true) throw new Error('clipboard busy')
      written.push(text)
    },
  }
}

function host(o: { failClipboard?: boolean; failOpen?: boolean } = {}) {
  const clipboard = fakeClipboard({ fail: o.failClipboard === true })
  const opened: string[] = []
  const deps: RecoveryHostDeps = {
    writeClipboard: (t) => clipboard.writeText(t),
    openExternal: (url) => {
      if (o.failOpen === true) return Promise.reject(new Error('no browser'))
      opened.push(url)
      return Promise.resolve()
    },
    log: { warn: vi.fn() },
  }
  return { clipboard, opened, deps }
}

const ok = (value: RecoveryResult): Result<unknown> => ({ ok: true, value })

describe('applyRecoveryResult', () => {
  it('shell_copy: the command is on the clipboard before the result is answered', async () => {
    const h = host()
    const r = ok({ kind: 'shell_copy', copied: 'claude auth login', message: 'Copied.' })
    expect(await applyRecoveryResult(r, h.deps)).toBe(r)
    expect(h.clipboard.written).toEqual(['claude auth login'])
    expect(h.opened).toEqual([])
  })

  it('a clipboard failure is an INTERNAL error, never a silent success', async () => {
    const h = host({ failClipboard: true })
    const r = await applyRecoveryResult(ok({ kind: 'shell_copy', copied: 'claude auth login' }), h.deps)
    expect(r).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'The command could not be copied to the clipboard.' },
    })
    const empty = await applyRecoveryResult(ok({ kind: 'shell_copy', copied: '' }), host().deps)
    expect(empty.ok).toBe(false)
  })

  it('open_docs: main opens the URL after checking the allowlist again', async () => {
    const h = host()
    const url = 'https://code.claude.com/docs/en/setup'
    const r = ok({ kind: 'open_docs', url, message: 'Opening.' })
    expect(await applyRecoveryResult(r, h.deps)).toBe(r)
    expect(h.opened).toEqual([url])
    for (const bad of [
      undefined,
      'http://code.claude.com/x',
      'https://evil.example/',
      'file:///C:/Windows',
    ]) {
      const g = host()
      const res = await applyRecoveryResult(
        ok({ kind: 'open_docs', ...(bad !== undefined ? { url: bad } : {}) }),
        g.deps,
      )
      expect(res.ok === false && res.error.code).toBe('VALIDATION')
      expect(g.opened).toEqual([])
    }
    const failing = await applyRecoveryResult(r, host({ failOpen: true }).deps)
    expect(failing).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'The link could not be opened in your browser.' },
    })
  })

  it('other kinds and failed results pass through with no side effect', async () => {
    const h = host()
    const link = ok({ kind: 'settings_link', route: '#/settings/vendors' })
    expect(await applyRecoveryResult(link, h.deps)).toBe(link)
    const failed: Result<unknown> = { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }
    expect(await applyRecoveryResult(failed, h.deps)).toBe(failed)
    expect(h.clipboard.written).toEqual([])
    expect(h.opened).toEqual([])
  })
})

describe('withRecoveryHost through the router', () => {
  const coreAnswering =
    (value: RecoveryResult): CoreInvoke =>
    (cmd: Cmd) =>
      Promise.resolve(cmd === 'recovery.execute' ? { ok: true, value } : { ok: true, value: { cmd } })

  it('recovery.execute from the renderer copies through main; other commands are untouched', async () => {
    const h = host()
    const core = vi.fn(coreAnswering({ kind: 'shell_copy', copied: 'claude auth login', message: 'Copied.' }))
    const router = createRouter({
      e2e: false,
      parse: (cmd, raw) => parseRequest(cmd, raw),
      main: {},
      core: withRecoveryHost(core, h.deps),
    })
    const r = await router(
      true,
      makeEnvelope('recovery.execute', { actionId: 'claude.login', folder: 'C:\\work\\app' }, 'c1'),
    )
    expect(r).toEqual({
      ok: true,
      value: { kind: 'shell_copy', copied: 'claude auth login', message: 'Copied.' },
    })
    expect(h.clipboard.written).toEqual(['claude auth login'])
    expect(core).toHaveBeenCalledWith('recovery.execute', {
      actionId: 'claude.login',
      folder: 'C:\\work\\app',
    })

    await router(true, makeEnvelope('runs.list', {}, 'c2'))
    expect(h.clipboard.written).toEqual(['claude auth login'])
    // A refused sender never reaches the core, so nothing is copied.
    await router(false, makeEnvelope('recovery.execute', { actionId: 'claude.login' }, 'c3'))
    expect(core).toHaveBeenCalledTimes(2)
    expect(h.clipboard.written).toEqual(['claude auth login'])
  })
})

describe('one shared allowlist', () => {
  it("main's allowlist is the shared one core checks open_docs against", () => {
    expect(MAIN_HOSTS).toBe(EXTERNAL_HOSTS)
    for (const url of [
      'https://code.claude.com/docs/en/setup',
      'https://github.com/openai/codex',
      'https://docs.x.ai/x',
      'http://claude.com',
      'https://user:pw@github.com/',
      'https://github.com:8443/',
      'https://notgithub.com/',
    ]) {
      expect(mainAllowed(url)).toBe(allowedExternalUrl(url))
    }
  })
})
