// The factory schedule's window in local time (factory/schedule.ts): open or not, when it closes, when it opens next.
import { describe, expect, it } from 'vitest'
import {
  clockMinutes,
  localDate,
  localDayBounds,
  nextScheduleEvent,
  scheduleWindow,
} from '@core/factory/schedule.ts'
import type { ScheduleSettings } from '@shared/factory.ts'

const ALL = [0, 1, 2, 3, 4, 5, 6]
const s = (o: Partial<ScheduleSettings> = {}): ScheduleSettings => ({
  enabled: true,
  start: '22:00',
  end: '06:00',
  days: ALL,
  resumeAutomatically: false,
  onBattery: false,
  ...o,
})
/** 2026-03-11 is a Wednesday (day 3). */
const at = (d: number, h: number, m = 0): number => new Date(2026, 2, d, h, m).getTime()

describe('clockMinutes', () => {
  it('reads HH:MM and refuses anything else', () => {
    expect(clockMinutes('00:00')).toBe(0)
    expect(clockMinutes('22:30')).toBe(1350)
    expect(clockMinutes('24:00')).toBeNull()
    expect(clockMinutes('7:00')).toBeNull()
  })
})

describe('scheduleWindow', () => {
  it('an overnight window is open before and after midnight, and closes the next morning', () => {
    expect(scheduleWindow(s(), at(11, 23))).toEqual({
      open: true,
      openedAt: at(11, 22),
      closesAt: at(12, 6),
      nextStart: at(12, 22),
    })
    expect(scheduleWindow(s(), at(12, 3))).toMatchObject({
      open: true,
      openedAt: at(11, 22),
      closesAt: at(12, 6),
    })
  })

  it('is closed outside the window and names the next start', () => {
    expect(scheduleWindow(s(), at(11, 12))).toEqual({ open: false, nextStart: at(11, 22) })
    // At the end exactly it is closed; at the start exactly it is open.
    expect(scheduleWindow(s(), at(12, 6)).open).toBe(false)
    expect(scheduleWindow(s(), at(11, 22)).open).toBe(true)
  })

  it('a same-day window closes the same day', () => {
    expect(scheduleWindow(s({ start: '09:00', end: '17:00' }), at(11, 10))).toMatchObject({
      open: true,
      openedAt: at(11, 9),
      closesAt: at(11, 17),
    })
  })

  it('end equal to start is a 24-hour window', () => {
    const w = scheduleWindow(s({ start: '08:00', end: '08:00' }), at(11, 7))
    expect(w).toMatchObject({ open: true, openedAt: at(10, 8), closesAt: at(11, 8) })
  })

  it('no end: open from the latest start, with no close', () => {
    const w = scheduleWindow(s({ end: null }), at(12, 10))
    expect(w.open).toBe(true)
    expect(w.openedAt).toBe(at(11, 22))
    expect(w.closesAt).toBeUndefined()
  })

  it('opens only on the chosen days (by the day the window starts)', () => {
    // Wednesday only: Wednesday night is open (into Thursday morning), Thursday night is not.
    const wed = s({ days: [3] })
    expect(scheduleWindow(wed, at(12, 2)).open).toBe(true)
    expect(scheduleWindow(wed, at(12, 23))).toEqual({ open: false, nextStart: at(18, 22) })
  })

  it('a disabled schedule, or one without days, is never open', () => {
    expect(scheduleWindow(s({ enabled: false }), at(11, 23))).toEqual({ open: false })
    expect(scheduleWindow(s({ days: [] }), at(11, 23))).toEqual({ open: false })
    expect(scheduleWindow(s({ start: 'soon' }), at(11, 23))).toEqual({ open: false })
  })
})

describe('nextScheduleEvent', () => {
  it("the open window's end, else the next start", () => {
    expect(nextScheduleEvent(s(), at(11, 23))).toBe(at(12, 6))
    expect(nextScheduleEvent(s(), at(11, 12))).toBe(at(11, 22))
    // Open with no end: the next window's start.
    expect(nextScheduleEvent(s({ end: null }), at(11, 23))).toBe(at(12, 22))
    expect(nextScheduleEvent(s({ enabled: false }), at(11, 23))).toBeUndefined()
  })
})

describe('local days', () => {
  it('localDate and localDayBounds follow the local calendar', () => {
    expect(localDate(at(11, 23, 59))).toBe('2026-03-11')
    expect(localDate(at(12, 0, 0))).toBe('2026-03-12')
    expect(localDayBounds(at(11, 15))).toEqual({ start: at(11, 0), end: at(12, 0) })
  })
})
