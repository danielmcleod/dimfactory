// Run requests from outside agents that wait for the user (core's `mcp-requests` event and mcp.requests.list). Kept
// apart from the main store: nothing else reads them, and the Dashboard's Needs you strip asks for them when it mounts.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { McpRunRequest } from '@shared/ipc.ts'
import { invoke } from '../ipc/client.ts'

interface McpRequestsState {
  pending: McpRunRequest[]
  /** Bumped by every event, so a list fetched before it does not overwrite it. */
  version: number
}

export const useMcpRequestsStore = create<McpRequestsState>(() => ({ pending: [], version: 0 }))

/** The `mcp-requests` event: core's whole pending list. */
export function setMcpRequests(pending: McpRunRequest[]): void {
  useMcpRequestsStore.setState((s) => ({ pending, version: s.version + 1 }))
}

/** Drop one request at once (approved or declined here); core's event follows. */
export function dropMcpRequest(id: string): void {
  useMcpRequestsStore.setState((s) => ({
    pending: s.pending.filter((r) => r.id !== id),
    version: s.version + 1,
  }))
}

/** The pending requests, read from core once on mount and kept current by the events. */
export function useMcpRequests(): McpRunRequest[] {
  const pending = useMcpRequestsStore((s) => s.pending)
  useEffect(() => {
    const before = useMcpRequestsStore.getState().version
    let alive = true
    void invoke('mcp.requests.list').then((r) => {
      if (!alive || !r.ok) return
      // An event that arrived meanwhile is newer.
      if (useMcpRequestsStore.getState().version !== before) return
      useMcpRequestsStore.setState((s) => ({ pending: r.value, version: s.version + 1 }))
    })
    return () => {
      alive = false
    }
  }, [])
  return pending
}

/** Tests: start empty. */
export function resetMcpRequestsForTests(): void {
  useMcpRequestsStore.setState({ pending: [], version: 0 })
}
