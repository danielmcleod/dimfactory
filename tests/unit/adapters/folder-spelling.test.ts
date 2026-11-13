// A vendor may name the pass folder by another spelling than the host gave it: a Node CLI (Gemini, Claude) and the
// fakes resolve paths against getcwd(), which on macOS reads /private/var for the /var folder Dim Factory spawned it
// in. A linked folder (a junction on Windows, a symlink elsewhere) stands in for /var here: the host's cwd is the
// link, the vendor names the real folder. Tool rows, ask details and the allow cache's "same folder" read it as the
// pass folder; a folder that is really elsewhere still reads as elsewhere.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpNormalizer } from '../../../src/core/adapters/acp-base/normalize.ts'
import { displayPath } from '../../../src/core/adapters/acp-base/permissions.ts'
import { COMMAND_APPROVAL, askFor } from '../../../src/core/adapters/codex/asks.ts'
import { geminiConfig } from '../../../src/core/adapters/gemini/config.ts'
import { relativeTo } from '../../../src/core/adapters/paths.ts'
import type { AllowRule } from '../../../src/shared/events.ts'

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'folder-spelling-')))
const real = join(base, 'real')
const link = join(base, 'link')
const other = join(base, 'other')
mkdirSync(join(real, 'src'), { recursive: true })
mkdirSync(other)
symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('the pass folder by its real path', () => {
  it('a tool row names a file in it relative to it; a file elsewhere stays absolute', () => {
    expect(relativeTo(join(real, 'src', 'cli.ts'), link)).toBe('src/cli.ts')
    expect(relativeTo(join(link, 'src', 'cli.ts'), link)).toBe('src/cli.ts')
    expect(relativeTo(join(other, 'x.ts'), link)).toBe(join(other, 'x.ts'))
    // A relative path or folder is never looked up.
    expect(relativeTo('src/cli.ts', link)).toBe('src/cli.ts')
  })

  it('an ACP ask names a file in it relative to it; a file elsewhere stays absolute', () => {
    expect(displayPath(join(real, 'src', 'cli.ts'), link)).toBe('src/cli.ts')
    expect(displayPath(join(other, 'x.ts'), link)).toBe(join(other, 'x.ts'))
    expect(displayPath(real, link)).toBe(real)
  })

  it('a Codex command in it may be allowed for the run; one elsewhere names its folder and never is', () => {
    const ctx = { requestId: 'r1', expiresAt: 0, cwd: link, changesOf: () => [] }
    const here = askFor(COMMAND_APPROVAL, { command: 'npm test', cwd: real }, ctx)
    expect(here.event.detail).toBe('npm test')
    expect(here.query).toMatchObject({ kind: 'shell', argv: ['npm', 'test'] })
    const away = askFor(COMMAND_APPROVAL, { command: 'npm test', cwd: other }, ctx)
    expect(away.event.detail).toBe(`npm test\nin ${other}`)
    expect(away.query).toBeUndefined()
  })

  it('an ACP shell request in it hits the run’s allow rule; one elsewhere is asked', async () => {
    const rule: AllowRule = {
      vendor: 'gemini',
      kind: 'shell',
      tool: 'shell',
      match: { argv: ['npm', 'test'] },
      source: 'exact',
    }
    const n = new AcpNormalizer({
      vendor: 'gemini',
      displayName: 'Gemini',
      step: 'implement',
      mode: 'autoedit',
      cwd: link,
      planNative: false,
      resumed: false,
      askTimeoutMs: 600_000,
      allowRules: [rule],
      optionPrefs: geminiConfig.optionPrefs,
      usage: geminiConfig.usage,
      modeRank: geminiConfig.modeRank,
      planRoots: [],
      requestPrefix: 'h:',
      now: () => 1_000,
    })
    const ask = (id: string, dir: string) => ({
      sessionId: 'sess-1',
      toolCall: {
        toolCallId: id,
        kind: 'execute',
        title: 'npm test',
        rawInput: { command: 'npm test', dir_path: dir },
      },
      options: [
        { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const hit = n.request(ask('t1', real), 1)
    expect(hit.step.events.some((e) => e.type === 'ask')).toBe(false)
    expect(await hit.reply).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } })
    const away = n.request(ask('t2', other), 2)
    expect(away.step.events.some((e) => e.type === 'ask')).toBe(true)
  })
})
