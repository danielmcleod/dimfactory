// Review (session id persistence: "Codex: from the thread/start response, before turn/start"):
// the engine's StartOptions.onSession answers whether run.json really holds the thread id, so the adapter ends the
// pass before any model call when it does not (the write-ahead in the controller only logs a failed write).
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionRecorded, StartOptions } from '../../../../src/core/adapters/types.ts'
import type { CodexHandle } from '../../../unit/balanced/engine/helpers.ts'
import { ScriptedCodex, World, runJsonOnDisk, settled } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const PLAN = { plan: { recording: 'C06-plan-native-host' } }
const BALANCED = { profile: 'balanced', gates: { afterPlan: false } }
const THREAD = 'thr_m8_persist'

/** Implement on Codex: reports its thread through onSession, then fails the pass as the real adapter would. */
function persistOnce(
  answers: SessionRecorded[],
  before?: (o: StartOptions) => void,
  after?: () => void,
): (h: CodexHandle, o: StartOptions) => void {
  return (h, o) => {
    void (async () => {
      h.thread = THREAD
      before?.(o)
      const r = (await o.onSession?.(THREAD)) ?? { ok: true }
      answers.push(r)
      after?.()
      h.events.emit({
        type: 'error',
        message: 'stopped before the turn (test)',
        raw: '',
        fatal: true,
        category: 'stream_malformed',
      })
      h.exit(1)
    })()
  }
}

describe('onSession answers whether the thread id is durable', () => {
  it('ok once run.json on disk holds the id', async () => {
    const answers: SessionRecorded[] = []
    const t = await w.boot(PLAN, new ScriptedCodex(persistOnce(answers)))
    const { runId, c } = await w.start(t, BALANCED)
    await c.waitFor((s) => answers.length > 0 || settled(s), 90_000)
    expect(answers).toEqual([{ ok: true }])
    expect(runJsonOnDisk(t.home, runId).steps.implement.sessionId).toBe(THREAD)
    await c.waitFor(settled, 90_000).catch(() => undefined)
  }, 180_000)

  it('not ok, with the errno, when run.json cannot be written', async () => {
    const answers: SessionRecorded[] = []
    // The core, once booted (the scripted Codex reaches its controller through it).
    const booted: { core?: Awaited<ReturnType<World['boot']>>['core'] } = {}
    let restore: (() => void) | undefined
    const t = await w.boot(
      PLAN,
      new ScriptedCodex(
        persistOnce(
          answers,
          (o) => {
            // run.json cannot be written from here on (a full disk).
            const store = booted.core?.controller(o.runId)?.deps.store
            if (store !== undefined) {
              const flush = store.flush.bind(store)
              restore = () => {
                store.flush = flush
              }
              store.flush = () =>
                Promise.reject(
                  Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
                )
            }
          },
          () => restore?.(),
        ),
      ),
    )
    booted.core = t.core
    const { c } = await w.start(t, BALANCED)
    await c.waitFor((s) => answers.length > 0 || settled(s), 90_000)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ ok: false, code: 'ENOSPC' })
    expect((answers[0] as { reason: string }).reason).toMatch(/run\.json could not be written/)
  }, 180_000)
})
