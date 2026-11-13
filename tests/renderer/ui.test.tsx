// components/ui primitives: loading buttons keep their label and their width (the spinner takes the icon slot),
// StableLabel reserves the widest label, status/AUTO badges, disabled-not-hidden hints, the countdown ring and small
// display pieces.
import './helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AutoBadge, StatusBadge } from '@renderer/components/ui/Badge.tsx'
import { Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button.tsx'
import { CountdownRing, countdownReserve } from '@renderer/components/ui/CountdownRing.tsx'
import { DisabledHint, LATER_VERSION } from '@renderer/components/ui/DisabledHint.tsx'
import { EmptyState } from '@renderer/components/ui/EmptyState.tsx'
import { Kbd } from '@renderer/components/ui/Kbd.tsx'
import { StableLabel } from '@renderer/components/ui/StableLabel.tsx'
import { StatusDot } from '@renderer/components/ui/StatusDot.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { setMacForTests } from '@renderer/lib/keys.ts'

afterEach(() => setMacForTests(null))

describe('Button', () => {
  it('keeps its label while loading, and is disabled and busy; the spinner takes the icon slot', () => {
    const { rerender } = render(<Button icon={<Check aria-hidden data-icon="" />}>Approve</Button>)
    const b = screen.getByRole('button', { name: 'Approve' })
    expect(b.querySelectorAll('svg')).toHaveLength(1)
    expect(b.querySelector('[data-icon]')).not.toBeNull()
    rerender(
      <Button loading icon={<Check aria-hidden data-icon="" />}>
        Approve
      </Button>,
    )
    expect(b.textContent).toBe('Approve')
    expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(b.getAttribute('aria-busy')).toBe('true')
    // The spinner replaces the icon: still one svg, so the button keeps its width.
    expect(b.querySelectorAll('svg')).toHaveLength(1)
    expect(b.querySelector('[data-spinner]')).not.toBeNull()
    expect(b.querySelector('[data-icon]')).toBeNull()
  })

  it('without an icon slot, a loading button adds no spinner (busy and disabled only)', () => {
    render(<Button loading>Approve</Button>)
    const b = screen.getByRole('button', { name: 'Approve' })
    expect(b.textContent).toBe('Approve')
    expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect(b.querySelector('svg')).toBeNull()
  })

  it('with only a keyboard chip, the spinner covers the chip instead of adding width', () => {
    setMacForTests(false)
    const { rerender } = render(<Button kbd="mod+enter">Approve</Button>)
    const b = screen.getByRole('button')
    const kbd = b.querySelector('kbd')
    expect(kbd?.textContent).toBe('Ctrl+Enter')
    expect(kbd?.getAttribute('aria-hidden')).toBe('true')
    rerender(
      <Button loading kbd="mod+enter">
        Approve
      </Button>,
    )
    expect(b.querySelector('kbd')?.className).toContain('invisible')
    expect(b.querySelector('[data-spinner]')?.parentElement).toBe(b.querySelector('kbd')?.parentElement)
  })

  it('reserves every label it can show, exposing only the current one', () => {
    const { rerender } = render(<Button labels={['Pause for 1 hour', 'Resume']}>Resume</Button>)
    const b = screen.getByRole('button', { name: 'Resume' })
    expect(b.textContent).toBe('Resume')
    const reserved = [...b.querySelectorAll('[data-label]')]
    expect(reserved.map((r) => r.getAttribute('data-label'))).toEqual(['Pause for 1 hour', 'Resume'])
    for (const r of reserved) {
      expect(r.getAttribute('aria-hidden')).toBe('true')
      expect(r.className).toContain('invisible')
      expect(r.textContent).toBe('')
    }
    rerender(<Button labels={['Pause for 1 hour', 'Resume']}>Pause for 1 hour</Button>)
    expect(screen.getByRole('button', { name: 'Pause for 1 hour' })).toBe(b)
  })

  it('keeps the icon, the label and the key hint together in the middle of the widest label’s room', () => {
    setMacForTests(false)
    render(
      <Button
        icon={<Check aria-hidden data-icon="" />}
        kbd="mod+enter"
        labels={['Approve', 'Approve edited plan']}
      >
        Approve
      </Button>,
    )
    const b = screen.getByRole('button', { name: 'Approve' })
    // What is read and found is the real content once: the copies that reserve the room say nothing.
    expect(b.textContent).toBe('ApproveCtrl+Enter')
    const cell = b.querySelector('[data-stable-label]')
    expect(cell?.className).toContain('justify-items-center')
    // The real row: icon, label and hint side by side (no room kept between them), centred in the cell.
    const row = cell?.firstElementChild
    expect(row?.querySelector('[data-icon]')).not.toBeNull()
    expect(row?.querySelector('kbd')?.textContent).toBe('Ctrl+Enter')
    expect(row?.textContent).toBe('ApproveCtrl+Enter')
    // Each copy holds the same slots: the icon, the label as generated content and the hint's room.
    const copies = [...(cell?.children ?? [])].slice(1)
    expect(copies).toHaveLength(2)
    for (const c of copies) {
      expect(c.getAttribute('aria-hidden')).toBe('true')
      expect(c.className).toContain('invisible')
      expect(c.textContent).toBe('')
      expect(c.querySelectorAll('svg')).toHaveLength(1)
      expect(c.querySelector('kbd')?.getAttribute('data-kbd-label')).toBe('Ctrl+Enter')
    }
  })

  it('filled variants carry outline’s 1 px border (transparent), so primary → outline keeps the size', () => {
    render(
      <>
        <Button variant="default">A</Button>
        <Button variant="secondary">B</Button>
        <Button variant="destructive">C</Button>
        <Button variant="outline">D</Button>
      </>,
    )
    for (const name of ['A', 'B', 'C', 'D']) {
      const cls = screen.getByRole('button', { name }).className.split(/\s+/)
      expect(cls, name).toContain('border')
      expect(
        cls.filter((c) => /^border-(transparent|input)$/.test(c)),
        name,
      ).toHaveLength(1)
    }
  })

  it('defaults to type=button and can render its child', () => {
    render(
      <>
        <Button>Run</Button>
        <Button asChild variant="link">
          <a href="#/runs">Runs</a>
        </Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Run' }).getAttribute('type')).toBe('button')
    expect(screen.getByRole('link', { name: 'Runs' }).className).toContain('underline-offset-4')
  })
})

describe('StableLabel', () => {
  it('stacks the current label and every reserved label in one grid cell', () => {
    render(
      <span data-testid="host">
        <StableLabel labels={['Copy', 'Copied', 'Copy']} current="Copied" align="start" />
      </span>,
    )
    const host = screen.getByTestId('host')
    const grid = host.querySelector('[data-stable-label]')
    expect(grid?.className).toContain('inline-grid')
    expect(grid?.className).toContain('justify-items-start')
    expect(grid?.className).toContain('*:col-start-1')
    expect(grid?.className).toContain('*:row-start-1')
    expect(host.textContent).toBe('Copied')
    // Duplicates are reserved once.
    expect([...host.querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label'))).toEqual([
      'Copy',
      'Copied',
    ])
  })
})

describe('badges and dots', () => {
  it('labels pass and run statuses from core', () => {
    render(
      <>
        <StatusBadge kind="pass" status="waiting" />
        <StatusBadge kind="run" status="waiting" />
        <StatusBadge kind="run" status="completed" />
        <AutoBadge />
        <StatusDot status="running" />
      </>,
    )
    expect(screen.getByText('Waiting').dataset['status']).toBe('waiting')
    expect(screen.getByText('Waiting for you')).toBeTruthy()
    expect(screen.getByText('Completed').className).toContain('text-st-done')
    expect(screen.getByText('AUTO').className).toContain('text-auto')
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy()
  })
})

describe('DisabledHint', () => {
  it('wraps a disabled control in a focusable element that names the reason', () => {
    render(
      <TooltipProvider>
        <DisabledHint>
          <Button disabled>Cancel all</Button>
        </DisabledHint>
        <DisabledHint reason="Busy: another run holds this folder">
          <Button disabled>Revert</Button>
        </DisabledHint>
      </TooltipProvider>,
    )
    const later = screen.getByLabelText(LATER_VERSION)
    expect(later.tabIndex).toBe(0)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel all' }).disabled).toBe(true)
    expect(screen.getByLabelText('Busy: another run holds this folder')).toBeTruthy()
  })
})

describe('CountdownRing', () => {
  it('names the time left and empties the ring', () => {
    const { rerender } = render(
      <CountdownRing expiresAt={130_000} totalMs={120_000} now={100_000} showLabel />,
    )
    const timer = screen.getByRole('timer')
    expect(timer.getAttribute('aria-label')).toBe('30s left')
    expect(timer.textContent).toBe('30s')
    rerender(<CountdownRing expiresAt={130_000} totalMs={120_000} now={140_000} />)
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Time is up')
    expect(screen.getByRole('timer').dataset['remainingMs']).toBe('0')
  })

  it('reserves the widest label the countdown can reach, so ticking never moves what is beside it', () => {
    expect(countdownReserve(45_000)).toEqual(['00s'])
    expect(countdownReserve(120_000)).toEqual(['00s', '0m 00s'])
    // A 15 min ask (timeouts.askMs is configurable): "14m 59s" is wider than "9m 59s", and both are reserved.
    expect(countdownReserve(15 * 60_000)).toEqual(['00s', '00m 00s'])
    expect(countdownReserve(2 * 3_600_000)).toEqual(['00s', '00m 00s', '0h 00m'])
    expect(countdownReserve(12 * 3_600_000)).toEqual(['00s', '00m 00s', '00h 00m'])

    const total = 15 * 60_000
    const { rerender } = render(<CountdownRing expiresAt={total} totalMs={total} now={1_000} showLabel />)
    const label = (): HTMLElement => {
      const el = screen.getByRole('timer').querySelector<HTMLElement>('[data-stable-label]')
      if (el === null) throw new Error('the label is not a StableLabel')
      return el
    }
    const reserved = (): string[] =>
      [...label().querySelectorAll('[data-label]')].map((n) => n.getAttribute('data-label') ?? '')
    expect(label().textContent).toBe('14m 59s')
    expect(reserved()).toEqual(['00s', '00m 00s'])
    expect(label().className).toContain('tabular-nums')
    // Below ten minutes and below one: the same reserve, only the shown text changes.
    rerender(<CountdownRing expiresAt={total} totalMs={total} now={total - 9 * 60_000} showLabel />)
    expect(label().textContent).toBe('9m 0s')
    expect(reserved()).toEqual(['00s', '00m 00s'])
    rerender(<CountdownRing expiresAt={total} totalMs={total} now={total - 5_000} showLabel />)
    expect(label().textContent).toBe('5s')
    expect(reserved()).toEqual(['00s', '00m 00s'])
  })
})

describe('EmptyState and Kbd', () => {
  it('renders the title, description and action', () => {
    render(
      <EmptyState
        title="No runs yet"
        description="Start one from the Dashboard."
        action={<Button>Start</Button>}
      />,
    )
    expect(screen.getByText('No runs yet')).toBeTruthy()
    expect(screen.getByText('Start one from the Dashboard.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
  })

  it('formats a combo for the platform', () => {
    setMacForTests(true)
    render(<Kbd combo="mod+enter" />)
    expect(screen.getByText('⌘↵').tagName).toBe('KBD')
  })
})
