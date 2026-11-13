// The CLI's TTY card prompt (CLI "Cards"; "Auto never implies trust"). A trust
// card has no defaultChoice ("never a default"), so a bare Enter must not pick [Trust for this project]: the prompt
// shows no "(default)" and asks for a number. Other cards keep their primary choice as the Enter default.
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Interaction, noEnterDefault } from '../../../src/cli/cards.ts'
import type { PromptSink } from '../../../src/cli/cards.ts'
import { LineReader, toIo } from '../../../src/cli/io.ts'
import { TRUST_CHOICE, trustCard, verifyEnvCard } from '../../../src/core/supervisor/cards.ts'
import type { CardView } from '../../../src/shared/run.ts'

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

const trust = (): CardView =>
  trustCard('trust-1', {
    step: 'verify:1',
    name: 'test',
    argv: ['npm', 'run', 'test'],
    cwdRel: '.',
    body: '{\n  "test": "vitest run"\n}',
    trust: 'untrusted',
  })

describe('CLI trust card prompt', () => {
  it('a bare Enter picks nothing: no "(default)", the number is asked again; then the typed choice', async () => {
    const { ix, stdin, lines, asks } = setup()
    const card = trust()
    expect(card.defaultChoice).toBeUndefined()
    expect(noEnterDefault(card)).toBe(true)
    const outcome = ix.decideCard(card, new AbortController().signal)
    stdin.write('\n')
    await new Promise((r) => setTimeout(r, 20))
    stdin.write('2\n')
    expect(await outcome).toEqual({ kind: 'choose', choiceId: TRUST_CHOICE.skip })
    expect(lines).toContain('  1) Trust for this project')
    expect(lines).toContain('  2) Skip')
    expect(lines.some((l) => l.includes('(default)'))).toBe(false)
    expect(lines).toContain('  Type a number from 1 to 2.')
    expect(asks).toEqual(['Choose 1-2: ', 'Choose 1-2: '])
  })

  it('Trust needs its number', async () => {
    const { ix, stdin } = setup()
    const outcome = ix.decideCard(trust(), new AbortController().signal)
    stdin.write('1\n')
    expect(await outcome).toEqual({ kind: 'choose', choiceId: TRUST_CHOICE.trust })
  })

  it('another card keeps its primary choice as the Enter default', async () => {
    const { ix, stdin, lines, asks } = setup()
    const card = verifyEnvCard('env-1', { step: 'verify:1', commands: [] })
    expect(noEnterDefault(card)).toBe(false)
    const outcome = ix.decideCard(card, new AbortController().signal)
    stdin.write('\n')
    const primary = card.choices.find((c) => c.primary === true) ?? card.choices[0]
    expect(await outcome).toEqual({ kind: 'choose', choiceId: primary?.id })
    expect(lines.some((l) => l.endsWith('(default)'))).toBe(true)
    expect(asks[0]).toMatch(/^Choose 1-\d \[\d\]: $/)
  })
})
