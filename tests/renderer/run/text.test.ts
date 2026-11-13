// Run view wording and ids copied from core (the renderer may not import src/core): card choice ids
// (supervisor/cards.ts CHOICE), skip reasons (supervisor/machine.ts SKIP_REASON), fresh-session reasons
// (supervisor/sessions.ts), the CLI's mode words (cli/render.ts); plus the light markdown parser, the steps the
// timeline shows and the log follower's gap handling.
import { describe, expect, it } from 'vitest'
import { FRESH_REASONS } from '@shared/run.ts'
import { CHOICE } from '@renderer/components/cards/payload.ts'
import { parseLightMarkdown } from '@renderer/components/run/LightMarkdown.tsx'
import { isShownStep, timelineColumns } from '@renderer/components/run/steps.ts'
import {
  FRESH_REASON_TEXT,
  MODE_TEXT,
  NOT_USED_REASONS,
  SKIP_REASON_TEXT,
  formatCommandLine,
  planModeText,
  skipReasonText,
} from '@renderer/components/run/text.ts'
import coreCards from '../../../src/core/supervisor/cards.ts?raw'
import coreMachine from '../../../src/core/supervisor/machine.ts?raw'
import coreSessions from '../../../src/core/supervisor/sessions.ts?raw'
import cliRender from '../../../src/cli/render.ts?raw'
import { snapWith } from './helpers.tsx'

/** `key: 'value',` pairs inside the `export const <name> = {` … `}` block of a source file. */
function constBlock(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`const ${name}`)
  expect(start).toBeGreaterThan(-1)
  const open = src.indexOf('{', start)
  const close = src.indexOf('\n}', open)
  const out: Record<string, string> = {}
  for (const m of src.slice(open, close).matchAll(/^\s*'?([\w-]+)'?:\s*'([^']*)',?\s*$/gm)) {
    out[m[1] as string] = m[2] as string
  }
  return out
}

describe('parity with core', () => {
  it('uses core card choice ids', () => {
    expect(constBlock(coreCards, 'CHOICE')).toEqual({ ...CHOICE })
  })

  it('knows every core skip reason and leaves out only the not-used ones', () => {
    const reasons = Object.values(constBlock(coreMachine, 'SKIP_REASON'))
    expect(reasons.length).toBeGreaterThan(5)
    expect(Object.keys(SKIP_REASON_TEXT).sort()).toEqual([...reasons].sort())
    for (const r of NOT_USED_REASONS) expect(reasons).toContain(r)
    expect(skipReasonText('no findings')).toBe('no findings to fix')
    expect(skipReasonText('something new')).toBe('something new')
  })

  it("words fresh-session reasons as core's session line does", () => {
    const core = constBlock(coreSessions, 'FRESH_REASON_TEXT')
    expect(Object.keys(core).sort()).toEqual([...FRESH_REASONS].sort())
    expect(core).toEqual({ ...FRESH_REASON_TEXT })
  })

  it("falls back to the CLI's mode words", () => {
    expect(constBlock(cliRender, 'MODE_TEXT')).toEqual({ ...MODE_TEXT })
  })
})

describe('wording', () => {
  it('names the plan mode', () => {
    expect(planModeText('native', 'claude')).toBe('Native plan · Claude plan mode')
    expect(planModeText('native', 'codex')).toBe('Native plan · Codex <proposed_plan>')
    expect(planModeText('emulated', 'claude')).toBe('Read-only + plan template')
    expect(planModeText('emulated', 'claude', 'empty plan')).toBe('Fell back to template: empty plan')
    expect(planModeText(undefined, 'claude')).toBeUndefined()
  })

  it('quotes launch arguments that need it', () => {
    expect(formatCommandLine(['C:\\Program Files\\x.exe', '-p', '', 'a"b'])).toBe(
      '"C:\\Program Files\\x.exe" -p "" "a\\"b"',
    )
  })
})

describe('light markdown', () => {
  it('splits headings, list items and fenced code, and keeps plain runs together', () => {
    const segs = parseLightMarkdown(
      '# Title\nplain one\nplain two\n- item\n12. numbered\n```\ncode\n```\ntail\n',
    )
    expect(segs).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'plain', text: 'plain one\nplain two' },
      { kind: 'list', indent: '', marker: '-', text: 'item' },
      { kind: 'list', indent: '', marker: '12.', text: 'numbered' },
      { kind: 'code', text: 'code' },
      { kind: 'plain', text: 'tail' },
    ])
  })

  it('shows an unclosed fence as code while it streams', () => {
    expect(parseLightMarkdown('```ts\nconst a = 1')).toEqual([{ kind: 'code', text: 'const a = 1' }])
  })
})

describe('timeline steps', () => {
  it('leaves out steps core skipped as unused and runner steps that never started', () => {
    const snap = snapWith({
      steps: {
        prepare: { status: 'skipped', reason: 'in place' },
        critic: { status: 'skipped', reason: 'disabled' },
        fix: { status: 'skipped', reason: 'no findings' },
        'verify:1': { status: 'queued' },
      },
    })
    expect(isShownStep(snap.steps.prepare)).toBe(false)
    expect(isShownStep(snap.steps.critic)).toBe(false)
    expect(isShownStep(snap.steps.fix)).toBe(true)
    expect(isShownStep(snap.steps['verify:1'])).toBe(false)
    expect(isShownStep({ ...snap.steps['verify:1'], status: 'running', attempt: 1 })).toBe(true)
    const cols = timelineColumns(snap).map((c) =>
      c.kind === 'gate' ? `◇${c.gate}` : c.steps.map((s) => s.key).join('‖'),
    )
    expect(cols).toEqual(['preflight', 'plan', '◇afterPlan', 'implement', 'review', '◇beforeFix', 'fix'])
  })

  it('puts Review and Critic in one column', () => {
    const cols = timelineColumns(snapWith({ summary: { auto: true } }))
    expect(cols.map((c) => (c.kind === 'gate' ? 'gate' : c.steps.map((s) => s.key).join('‖')))).toEqual([
      'preflight',
      'plan',
      'implement',
      'review‖critic',
      'fix',
    ])
  })
})
