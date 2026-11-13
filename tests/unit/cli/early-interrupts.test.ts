// Ctrl+C before the CLI follows a run (runs.start, first-launch setup, a resume still in flight) is caught and kept
// with when it happened, so driveRun can replay it (the 2 s hard-kill rule still reads the real times). Once taken,
// the early handler is gone and later presses go to driveRun's own.
import { describe, expect, it } from 'vitest'
import { EarlyInterrupts } from '../../../src/cli/drive.ts'
import type { CliIo } from '../../../src/cli/io.ts'

function fakeIo(): { io: CliIo; press: () => void; handlers: () => number } {
  const hs: (() => void)[] = []
  const io = {
    onInterrupt: (fn: () => void) => {
      hs.push(fn)
      return () => {
        const i = hs.indexOf(fn)
        if (i >= 0) hs.splice(i, 1)
      }
    },
  } as unknown as CliIo
  return { io, press: () => [...hs].forEach((h) => h()), handlers: () => hs.length }
}

describe('EarlyInterrupts', () => {
  it('keeps every press with its time, oldest first, and stops listening once taken', () => {
    const f = fakeIo()
    let now = 1000
    const early = new EarlyInterrupts(f.io, () => now)
    expect(f.handlers()).toBe(1)
    f.press()
    now = 1500
    f.press()
    expect(early.take()).toEqual([1000, 1500])
    expect(f.handlers()).toBe(0)
    // Later presses are not caught here any more.
    f.press()
    expect(early.take()).toEqual([])
  })

  it('a take with no presses answers none (the run was not interrupted)', () => {
    const f = fakeIo()
    const early = new EarlyInterrupts(f.io)
    expect(early.take()).toEqual([])
    expect(f.handlers()).toBe(0)
  })
})
