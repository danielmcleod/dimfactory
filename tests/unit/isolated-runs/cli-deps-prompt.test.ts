// Review fix (CLI "Cards"; Prepare step 3; "Auto never implies trust"; "a card
// that grants trust has no Enter default"): the depsConsent card's [Install] writes a `deps` grant, so the CLI's TTY
// prompt gives it no Enter default either. A bare Enter picks nothing; the number must be typed.
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Interaction, noEnterDefault } from '../../../src/cli/cards.ts'
import type { PromptSink } from '../../../src/cli/cards.ts'
import { LineReader, toIo } from '../../../src/cli/io.ts'
import { DEPS_CHOICE, depsConsentCard, depsFailedCard } from '../../../src/core/supervisor/cards.ts'

function setup(): { ix: Interaction; stdin: PassThrough; lines: string[]; asks: string[] } {
  const stdin = new PassThrough()
  const lines: string[] = []
  const asks: string[] = []
  const sink: PromptSink = {
    line: (t) => lines.push(t),
    ask: (t) => asks.push(t),
    endLine: () => undefined,
  }
  const io = toIo({ out: (l) => lines.push(l), err: (l) => lines.push(l), stdin, isTTY: true })
  const ix = new Interaction(
    io,
    { gates: 'ask', cards: 'ask', asks: 'ask', tty: true },
    sink,
    new LineReader(stdin),
  )
  return { ix, stdin, lines, asks }
}

const deps = {
  manager: 'pnpm',
  argv: ['pnpm', 'install', '--frozen-lockfile'],
  cwdRel: '.',
  source: 'detected' as const,
  lockfile: 'pnpm-lock.yaml',
}

describe('CLI depsConsent prompt', () => {
  it('a bare Enter picks nothing (no "(default)"); the typed number decides', async () => {
    const { ix, stdin, lines, asks } = setup()
    const card = depsConsentCard('deps-1', { deps, trust: 'untrusted' })
    expect(noEnterDefault(card)).toBe(true)
    const outcome = ix.decideCard(card, new AbortController().signal)
    stdin.write('\n')
    await new Promise((r) => setTimeout(r, 20))
    stdin.write('3\n')
    expect(await outcome).toEqual({ kind: 'choose', choiceId: DEPS_CHOICE.skipInstall })
    expect(lines.some((l) => l.includes('(default)'))).toBe(false)
    expect(lines).toContain('  1) Install')
    expect(asks[0]).toMatch(/^Choose 1-\d: $/)
    expect(asks).toHaveLength(2)
  })

  it('Install needs its number', async () => {
    const { ix, stdin } = setup()
    const outcome = ix.decideCard(
      depsConsentCard('deps-1', { deps, trust: 'untrusted' }),
      new AbortController().signal,
    )
    stdin.write('1\n')
    expect(await outcome).toEqual({ kind: 'choose', choiceId: DEPS_CHOICE.install })
  })

  it('depsFailed (it writes no grant) keeps its primary choice as the Enter default', () => {
    expect(noEnterDefault(depsFailedCard('deps-2', { deps, reason: 'exit 1' }))).toBe(false)
  })
})
