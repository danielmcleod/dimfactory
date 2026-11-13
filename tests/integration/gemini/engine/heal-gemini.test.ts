// Self-heal for a failed Gemini pass, through a real core ("Uses the selfHeal vendor,
// falling back to the first ready of claude/codex", "Unsafe actions are dropped, with 'Dim Factory hid N unsafe
// suggestions'"; "the vendor adapter's own extraArgs and flagMap launch rules over the values the ops write"):
//   - an unknown failure of a Gemini Review is diagnosed by Codex (the selfHeal vendor here), never by Gemini
//   - a suggestion that would put a flag widening what a Gemini pass may do (more folders, another approval mode) into
//     `vendors.gemini.extraArgs` is hidden by Gemini's own launch rules, and so is `-y` inside a combined short flag
//     (`-dy`: a heal never combines short flags; Gemini's rules refuse it too); a model fix is kept
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedCodex, codexPlays } from '../../balanced/engine/helpers.ts'
import { ScriptedGemini, World, failedWithSnag, geminiPlays, value } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const DIAGNOSIS = 'Gemini could not read a file outside the folder.'
const ANSWER = [
  'Diagnosis below.',
  '```json',
  JSON.stringify({
    diagnosis: DIAGNOSIS,
    confidence: 'medium',
    category: 'unknown',
    actions: [
      {
        kind: 'config',
        ops: [{ op: 'add', path: '/vendors/gemini/extraArgs', value: ['--include-directories', '..'] }],
        reason: 'Let Gemini read the parent folder.',
      },
      {
        kind: 'config',
        ops: [{ op: 'add', path: '/vendors/gemini/extraArgs', value: ['--approval-mode', 'auto_edit'] }],
        reason: 'Let Gemini edit without asking.',
      },
      {
        // `-dy` is `--debug --yolo` to Gemini's parser (a combined short flag, read letter by letter).
        kind: 'config',
        ops: [{ op: 'add', path: '/vendors/gemini/extraArgs', value: ['-dy'] }],
        reason: 'Show debug output.',
      },
      {
        kind: 'config',
        ops: [{ op: 'replace', path: '/passes/review/model', value: null }],
        reason: 'Use the default model.',
      },
    ],
  }),
  '```',
].join('\n')

describe('heal for a Gemini pass', () => {
  it('Codex diagnoses; Gemini-widening extraArgs are hidden, the model fix is kept', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', text: ANSWER }]))
    const gemini = new ScriptedGemini(
      geminiPlays([
        {
          fail: {
            category: 'unknown',
            message: 'zork: the frobnicator is out of phase',
            raw: 'zork: the frobnicator is out of phase',
            classifiedBy: 'heuristic',
          },
        },
      ]),
    )
    const t = await w.boot(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [
          { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
        ],
      },
      gemini,
      {
        codex,
        trust: true,
        user: { selfHeal: { enabled: true, vendor: 'codex', model: null, autoApplyConfigPatches: false } },
      },
    )
    const { runId, c } = await w.start(t, {
      profile: 'claude-only',
      gates: { afterPlan: false },
      passes: { review: { vendor: 'gemini', model: 'gemini-3-pro-preview' } },
    })
    const healed = await c.waitFor(
      (s) =>
        failedWithSnag('review')(s) &&
        s.steps.review.heal !== undefined &&
        s.steps.review.heal.status !== 'running',
      120_000,
    )
    expect(healed.steps.review.failure).toMatchObject({ category: 'unknown' })
    // The healer ran on Codex (read-only, ephemeral); Gemini only ran its own Review (never a heal: unit suite).
    expect(codex.starts.map((s) => [s.step, s.mode, s.ephemeral])).toEqual([['heal', 'readonly', true]])
    expect(gemini.starts.map((s) => s.step)).toEqual(['review'])
    const view = value(await t.core.invoke('runs.get', { runId })).steps.review.heal
    expect(view).toMatchObject({ status: 'ok', diagnosis: DIAGNOSIS, hidden: 3 })
    const kept = view?.actions.filter((a) => a.kind === 'config_patch') ?? []
    expect(kept).toHaveLength(1)
    expect(JSON.stringify(kept)).toContain('/passes/review/model')
    expect(JSON.stringify(view?.actions)).not.toContain('--include-directories')
    expect(JSON.stringify(view?.actions)).not.toContain('--approval-mode')
    expect(JSON.stringify(view?.actions)).not.toContain('-dy')
  }, 180_000)
})
