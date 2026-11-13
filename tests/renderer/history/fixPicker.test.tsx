// Re-run from Fix's findings picker (Re-run from Fix carries the selected findings;
// "the palette is the only modal": inline; "buttons never change size"). The findings must first, the ticks core
// says (else every finding, as the gate before Fix starts), the count line, the request it sends, Cancel, the source
// that is stopped first, and findings.json read defensively.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import {
  defaultSelection,
  FixPicker,
  fixPickerStartLabel,
  PICK_ONE_REASON,
} from '@renderer/components/run/FixPicker.tsx'
import type { FixPickerProps } from '@renderer/components/run/FixPicker.tsx'
import {
  parseFindingsFile,
  readRerunFromFix,
  resetFixPickersForTests,
  stopsSourceFirst,
} from '@renderer/components/run/rerun.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { finding, FINDINGS, findingsFile } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.rerun': () => ({ runId: 'next', displayNo: 12 }) } })
})

afterEach(() => {
  resetFixPickersForTests()
  tearDown(mock)
})

function mount(over: Partial<FixPickerProps> = {}): { onCancel: ReturnType<typeof vi.fn> } {
  const onCancel = vi.fn()
  render(
    <Providers>
      <FixPicker
        runId="src"
        displayNo={7}
        findings={FINDINGS}
        facts={{ available: true, fresh: false }}
        why={null}
        stopsSource={false}
        onCancel={onCancel}
        {...over}
      />
    </Providers>,
  )
  return { onCancel }
}

const boxes = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Findings' })).getAllByRole('checkbox')
const ticks = (): (string | null)[] => boxes().map((b) => b.getAttribute('aria-checked'))

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

describe('the picker', () => {
  it('is inline (no dialog), must first, every finding ticked when core names no default', () => {
    mount()
    expect(screen.queryByRole('dialog')).toBeNull()
    const picker = screen.getByTestId('fix-picker-src')
    expect(picker.tagName).toBe('SECTION')
    const rows = within(picker).getAllByRole('listitem')
    expect(rows.map((r) => r.dataset['severity'])).toEqual(['must', 'must', 'should', 'should'])
    expect(ticks()).toEqual(['true', 'true', 'true', 'true'])
    expect(screen.getByTestId('fix-picker-receives').textContent).toBe('Fix will receive 2 must · 2 should')
    expect(screen.getByTestId('fix-picker-start').textContent).toBe('Re-run from Fix with 4 findings')
    expect(picker.textContent).toContain('carried over from run #7, not run again')
  })

  it("starts with core's default: every must and the shoulds chosen at the gate", () => {
    mount({ facts: { available: true, fresh: false, findingIds: ['f1', 'f2', 'f4'] } })
    expect(ticks()).toEqual(['true', 'true', 'false', 'true'])
    expect(screen.getByTestId('fix-picker-receives').textContent).toBe('Fix will receive 2 must · 1 should')
  })

  it('sends the ticked findings in core’s order, then opens the new run', async () => {
    mount()
    await click(boxes()[0] as HTMLElement)
    await click(boxes()[3] as HTMLElement)
    expect(screen.getByTestId('fix-picker-receives').textContent).toBe('Fix will receive 1 must · 1 should')
    expect(screen.getByTestId('fix-picker-start').textContent).toBe('Re-run from Fix with 2 findings')
    await click(screen.getByTestId('fix-picker-start'))
    expect(mock.callsOf('runs.rerun')).toEqual([{ runId: 'src', from: 'fix', findingIds: ['f2', 'f3'] }])
    expect(window.location.hash).toBe('#/runs/next')
  })

  it('Untick all disables the start with the reason; Tick all brings every finding back', async () => {
    mount()
    await click(screen.getByTestId('fix-picker-untick-all'))
    expect(ticks()).toEqual(['false', 'false', 'false', 'false'])
    const start = screen.getByTestId<HTMLButtonElement>('fix-picker-start')
    expect(start.disabled).toBe(true)
    expect(screen.getByText(PICK_ONE_REASON)).toBeTruthy()
    expect(start.textContent).toBe('Re-run from Fix with 0 findings')
    await click(screen.getByTestId('fix-picker-tick-all'))
    expect(ticks()).toEqual(['true', 'true', 'true', 'true'])
    expect(screen.getByTestId<HTMLButtonElement>('fix-picker-start').disabled).toBe(false)
  })

  it('keeps the start button’s width for every count (the widest label reserved)', () => {
    mount({ findings: Array.from({ length: 12 }, (_, i) => finding(i + 1, 'must', `M${i + 1}`)) })
    const reserved = [...screen.getByTestId('fix-picker-start').querySelectorAll('[data-label]')].map((e) =>
      e.getAttribute('data-label'),
    )
    expect(reserved).toContain('Re-run from Fix with 00 findings')
  })

  it('says whether Fix continues Implement’s session, or starts fresh and why', () => {
    mount({
      facts: { available: true, fresh: true, reason: 'model-differs' },
      why: 'Fix uses a different model and Claude cannot switch models when resuming.',
    })
    expect(screen.getByTestId('fix-picker-session').textContent).toBe(
      'Fix would start a fresh session: the model differs. ' +
        'Fix uses a different model and Claude cannot switch models when resuming.',
    )
  })

  it('says the source is stopped first while it holds its folder (the re-run takes the folder)', () => {
    mount({ stopsSource: true })
    expect(screen.getByTestId('fix-picker-stops-source').textContent).toBe(
      'Run #7 still holds its folder, so it is stopped when the new run starts.',
    )
    expect(stopsSourceFirst({ lock: 'held', status: 'paused' })).toBe(true)
    expect(stopsSourceFirst({ lock: 'held', status: 'failed' })).toBe(true)
    expect(stopsSourceFirst({ status: 'failed' })).toBe(false)
    expect(stopsSourceFirst({ lock: 'held', status: 'cancelled' })).toBe(false)
  })

  it('Cancel hands back to the caller and sends nothing', async () => {
    const { onCancel } = mount()
    await click(screen.getByTestId('fix-picker-cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(mock.callsOf('runs.rerun')).toEqual([])
  })

  it('a refused re-run is a toast with core’s words; the picker stays with its ticks', async () => {
    mock.on('runs.rerun', () => {
      throw mockError('CONFLICT', 'Run #7 changed since; open it again.')
    })
    mount()
    await click(boxes()[2] as HTMLElement)
    await click(screen.getByTestId('fix-picker-start'))
    expect(useStore.getState().toasts.items.map((t) => t.message)).toContain(
      'Run #7 changed since; open it again.',
    )
    expect(ticks()).toEqual(['true', 'true', 'false', 'true'])
    expect(window.location.hash).toBe('')
  })
})

describe('reading core’s facts', () => {
  it('findings.json: must first, defaults filled in, anything else refused', () => {
    const mixed: Finding[] = [finding(3, 'should', 'S'), finding(1, 'must', 'M')]
    const got = parseFindingsFile(findingsFile(mixed))
    expect(got?.map((f) => f.id)).toEqual(['f1', 'f3'])
    expect(
      parseFindingsFile('{"findings":[{"id":"x","n":1,"severity":"must","source":"review","title":"T"}]}'),
    ).toEqual([{ id: 'x', n: 1, severity: 'must', source: 'review', title: 'T', body: '', flags: [] }])
    expect(parseFindingsFile('not json')).toBeNull()
    expect(parseFindingsFile('{"findings":"no"}')).toBeNull()
  })

  it('rerunFromFix: core’s reason without its full stop, its default ids, junk dropped', () => {
    expect(
      readRerunFromFix({ available: false, fresh: true, unavailable: 'The run has no findings.' }),
    ).toEqual({
      available: false,
      fresh: true,
      disabledReason: 'The run has no findings',
    })
    expect(readRerunFromFix({ available: true, fresh: true, reason: 'nope', findingIds: ['a', 2] })).toEqual({
      available: true,
      fresh: true,
      findingIds: ['a'],
    })
    expect(readRerunFromFix(undefined)).toBeNull()
    expect(defaultSelection(FINDINGS, { findingIds: ['f2', 'gone'] })).toEqual(new Set(['f2']))
    expect(defaultSelection(FINDINGS, null)).toEqual(new Set(['f1', 'f2', 'f3', 'f4']))
    expect(fixPickerStartLabel(1)).toBe('Re-run from Fix with 1 finding')
  })
})
