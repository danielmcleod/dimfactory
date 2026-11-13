// The forbidden-command guardrail reads the whole command, not a tool row's summary, which is clipped to one line.
import { describe, expect, it } from 'vitest'
import { ClaudeNormalizer } from '@core/adapters/claude/normalize.ts'
import { CodexNormalizer } from '@core/adapters/codex/normalize.ts'
import { commandMatches } from '@shared/guardrails.ts'
import type { AdapterSignal } from '@shared/events.ts'

const commands = (signals: readonly AdapterSignal[]): string[] =>
  signals.flatMap((s) => (s.type === 'shell-command' ? [s.command] : []))

const MULTI = 'git add .\ngit commit -m x\ngit push origin main'

describe('the whole shell command reaches the guardrails', () => {
  it('Claude: a command on several lines', () => {
    const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 600_000, now: () => 0 })
    const step = n.line(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm',
          content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: MULTI } }],
        },
        parent_tool_use_id: null,
      }),
    )
    expect(commands(step.signals)).toEqual([MULTI])
    expect(commandMatches(MULTI, ['git', 'push'])).toBe(true)
  })

  it('Claude: other tools send nothing', () => {
    const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 600_000, now: () => 0 })
    const step = n.line(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm',
          content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a' } }],
        },
        parent_tool_use_id: null,
      }),
    )
    expect(commands(step.signals)).toEqual([])
  })

  const codex = (): CodexNormalizer =>
    new CodexNormalizer({
      step: 'implement',
      mode: 'autoedit',
      cwd: '/w',
      planNative: false,
      resumed: false,
      askTimeoutMs: 600_000,
      allowRules: [],
      structured: false,
      loopback: false,
      now: () => 1000,
    })

  it("Codex: the script inside its shell wrapper, even when its summary says only 'Read'", () => {
    const step = codex().notification('item/started', {
      item: {
        type: 'commandExecution',
        id: 'c1',
        command: `"C:\\Windows\\powershell.exe" -Command 'cat a; git push'`,
        status: 'inProgress',
        commandActions: [{ type: 'read', command: 'cat a', name: 'a', path: 'a' }],
      },
    })
    const [command] = commands(step.signals)
    expect(command).toBeDefined()
    expect(commandMatches(command ?? '', ['git', 'push'])).toBe(true)
  })

  it('Codex: other items send nothing', () => {
    const step = codex().notification('item/started', {
      item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [] },
    })
    expect(commands(step.signals)).toEqual([])
  })
})
