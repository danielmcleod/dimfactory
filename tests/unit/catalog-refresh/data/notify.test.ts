// `catalog` notification gating (the `catalog` event "Model prices may be out of date", notification
// rules): core hands the host one notice per due date (scheduler.test.ts); the host shows a desktop notification only
// with events.catalog on and the window unfocused, an in-app toast while focused, nothing while paused or off.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  decideSurface,
  notificationText,
} from '../../../../src/main/notifications-model.ts'
import type { NotificationSettings } from '../../../../src/main/notifications-model.ts'
import { NOW } from './fixtures.ts'

const withCatalog = (catalog: boolean): NotificationSettings => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, catalog },
})

const surface = (o: { catalog: boolean; focused: boolean; pausedUntil?: number | null }) =>
  decideSurface({
    event: 'catalog',
    settings: withCatalog(o.catalog),
    focused: o.focused,
    pausedUntil: o.pausedUntil ?? null,
    now: NOW,
    supported: true,
  })

describe('the catalog notification', () => {
  it('is off by default (events.catalog false)', () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.events.catalog).toBe(false)
    expect(surface({ catalog: false, focused: false })).toEqual({ kind: 'none', reason: 'event-off' })
  })

  it('on: desktop when unfocused, an in-app toast when focused, nothing while paused', () => {
    expect(surface({ catalog: true, focused: false })).toEqual({ kind: 'native' })
    expect(surface({ catalog: true, focused: true })).toEqual({ kind: 'in-app' })
    expect(surface({ catalog: true, focused: false, pausedUntil: NOW + 60_000 })).toEqual({
      kind: 'none',
      reason: 'paused',
    })
  })

  it('reads "Model prices may be out of date"', () => {
    expect(notificationText({ kind: 'catalog' }, { now: NOW, actions: false }).title).toBe(
      'Model prices may be out of date',
    )
  })
})
