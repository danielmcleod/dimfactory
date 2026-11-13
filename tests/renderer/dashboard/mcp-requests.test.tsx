// Outside agents' run requests in the Dashboard's Needs you strip: read on mount and kept current by the
// `mcp-requests` event, shown after core's items in the same fixed slots (who asked, the task, the folder and profile),
// Approve starts the run through core and opens it, a blocked start says why and keeps the request, Decline drops it.
// Approve and Decline take clicks only ASK_ARM_MS after the row appears or moves up (a double click on the row that was
// there before never approves a run).
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpRunRequest } from '@shared/ipc.ts'
import { ASK_ARM_MS } from '@renderer/components/attention/AskCard.tsx'
import { NeedsYouStrip } from '@renderer/pages/dashboard/NeedsYouStrip.tsx'
import { requestDetails } from '@renderer/pages/dashboard/McpRequestItem.tsx'
import { resetMcpRequestsForTests, setMcpRequests } from '@renderer/state/mcpRequests.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from './setup.tsx'

const REQ: McpRunRequest = {
  id: 'req-1',
  folder: 'C:\\work\\app',
  task: 'Add a --version flag\nwith a test',
  profile: 'balanced',
  notes: 'The user asked in chat.',
  requestedBy: 'Claude Code 2.1',
  requestedAt: new Date(2026, 9, 6, 14, 55).getTime(),
  expiresAt: new Date(2026, 9, 7, 14, 55).getTime(),
  status: 'pending',
}

let mock: MockDimFactory
let pending: McpRunRequest[]

beforeEach(() => {
  pending = [REQ]
  resetMcpRequestsForTests()
  mock = setUp({
    handlers: {
      'mcp.requests.list': () => pending,
      'mcp.requests.approve': () => ({ runId: 'run-7', displayNo: 7 }),
      'mcp.requests.decline': () => undefined,
    },
  })
})
afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  render(
    <Providers>
      <NeedsYouStrip />
    </Providers>,
  )
  await settle()
}

/** Mounted, with the request row's buttons armed. */
async function mountArmed(): Promise<void> {
  await mount()
  await settle(ASK_ARM_MS)
}

describe('Needs you: requests from outside agents', () => {
  it('shows who asked, the task, the folder and the profile, with the whole request in its tooltip', async () => {
    await mount()
    const row = screen.getByTestId('needs-you-request-req-1')
    expect(row.className).toContain('h-14')
    expect(within(row).getByTestId('request-task').textContent).toBe(
      'Claude Code 2.1 asks to run: Add a --version flag',
    )
    expect(within(row).getByTestId('request-where').textContent).toContain('C:\\work\\app · profile balanced')
    expect(row.getAttribute('title')).toBe(requestDetails(REQ))
    expect(requestDetails(REQ)).toContain('Notes from the agent: The user asked in chat.')
    expect(screen.getByTestId('needs-you').getAttribute('data-requests')).toBe('1')
    expect(screen.getByTestId('needs-you').textContent).not.toContain('\u2014')
  })

  it('follows the mcp-requests event; nothing when none wait', async () => {
    pending = []
    await mount()
    expect(screen.getByTestId('needs-you-none')).toBeTruthy()
    setMcpRequests([REQ, { ...REQ, id: 'req-2', task: 'Second' }])
    await settle()
    expect(screen.getByTestId('needs-you-request-req-1')).toBeTruthy()
    // The second waits behind "Show 1 more": the strip keeps its height.
    expect(screen.queryByTestId('needs-you-request-req-2')).toBeNull()
    fireEvent.click(screen.getByTestId('needs-you-more'))
    expect(screen.getByTestId('needs-you-request-req-2')).toBeTruthy()
  })

  it('comes after core’s own items', async () => {
    useStore.setState((s) => ({
      attention: {
        needsYou: 1,
        items: [
          {
            id: 'paused:r1',
            kind: 'paused',
            runId: 'r1',
            displayNo: 1,
            title: 'Earlier run',
            since: Date.now(),
            step: 'implement',
            pause: 'user',
          } as never,
        ],
      },
      app: s.app,
    }))
    await mount()
    expect(screen.queryByTestId('needs-you-request-req-1')).toBeNull()
    expect(screen.getByTestId('needs-you-more').textContent).toContain('Show 1 more')
  })

  it('Approve starts the run through core and opens it', async () => {
    await mountArmed()
    fireEvent.click(screen.getByTestId('request-approve'))
    await settle()
    expect(mock.callsOf('mcp.requests.approve')).toEqual([{ id: 'req-1' }])
    expect(window.location.hash).toBe('#/runs/run-7')
    expect(screen.queryByTestId('needs-you-request-req-1')).toBeNull()
  })

  it('a blocked start says why and keeps the request', async () => {
    mock.on('mcp.requests.approve', () => {
      throw mockError('PREFLIGHT_BLOCKED', 'Codex: not installed')
    })
    await mountArmed()
    fireEvent.click(screen.getByTestId('request-approve'))
    await settle()
    expect(screen.getByTestId('needs-you-request-req-1')).toBeTruthy()
    expect(document.body.textContent).toContain('The run did not start: Codex: not installed')
  })

  it('Decline drops it', async () => {
    await mountArmed()
    fireEvent.click(screen.getByTestId('request-decline'))
    await settle()
    expect(mock.callsOf('mcp.requests.decline')).toEqual([{ id: 'req-1' }])
    expect(screen.queryByTestId('needs-you-request-req-1')).toBeNull()
    expect(screen.getByTestId('needs-you-none')).toBeTruthy()
  })

  it('a click as the row appears, or as it moves up into the place of an answered ask, approves nothing', async () => {
    const ask = {
      id: 'ask:r1:q1',
      kind: 'ask',
      runId: 'r1',
      displayNo: 1,
      title: 'Earlier run',
      since: Date.now(),
      step: 'implement',
      ask: { requestId: 'q1', kind: 'shell', detail: 'npm test', expiresAt: Date.now() + 60_000 },
    } as never
    useStore.setState((s) => ({ attention: { needsYou: 1, items: [ask] }, app: s.app }))
    await mount()
    await settle(ASK_ARM_MS)
    // The ask is answered: the request takes its place, and the second click of a double click lands on Approve.
    useStore.setState((s) => ({ attention: { needsYou: 0, items: [] }, app: s.app }))
    await settle()
    const row = screen.getByTestId('needs-you-request-req-1')
    expect(row.getAttribute('data-armed')).toBeNull()
    fireEvent.click(within(row).getByTestId('request-approve'))
    await settle()
    expect(mock.callsOf('mcp.requests.approve')).toEqual([])
    // Once it has stayed there for ASK_ARM_MS, a click approves.
    await settle(ASK_ARM_MS)
    expect(row.getAttribute('data-armed')).toBe('true')
    fireEvent.click(within(row).getByTestId('request-approve'))
    await settle()
    expect(mock.callsOf('mcp.requests.approve')).toEqual([{ id: 'req-1' }])
  })

  it('a click as the strip first shows the request declines nothing', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('request-decline'))
    await settle()
    expect(mock.callsOf('mcp.requests.decline')).toEqual([])
  })
})
