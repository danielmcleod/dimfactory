// "It's not working": what the person sees goes in as what they see, with the order that keeps a fix honest.
import { describe, expect, it } from 'vitest'
import { notWorkingTask } from '@core/easy/change.ts'

describe('notWorkingTask', () => {
  const task = notWorkingTask('The save button does nothing')

  it('carries their words, and does not take them as the cause', () => {
    expect(task).toContain('The save button does nothing')
    expect(task).toMatch(/may not name the real cause/)
  })

  it('reproduces before fixing, and checks afterwards', () => {
    const order = ['Make it happen yourself', 'Find the cause', 'Fix the cause', 'confirm it now works'].map(
      (s) => task.indexOf(s),
    )
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('does not guess when it cannot reproduce', () => {
    expect(task).toMatch(/do not change anything to guess/)
  })
})
