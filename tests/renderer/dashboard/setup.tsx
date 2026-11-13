// Shared setup for the shell, Dashboard, Runs and Settings tests: a clean store, fake timers, the mock bridge, and
// providers (tooltips, toasts) around what a test renders. Import '../helpers/rtl.ts' before this file.
import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import type { PassName } from '@shared/run.ts'
import type { ProbeView, VendorHealth } from '@shared/vendors.ts'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { resetMiniTimelineForTests } from '@renderer/pages/dashboard/ActiveRunCard.tsx'
import { resetSetupStateForTests } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { InstallOptions, MockDimFactory } from '../helpers/mockDimFactory.ts'

export function Providers({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider>
      {children}
      <Toaster />
    </TooltipProvider>
  )
}

function clearStorage(): void {
  try {
    window.localStorage.clear()
  } catch {
    // happy-dom always has storage; a browser without it just has nothing to clear.
  }
}

/**
 * beforeEach: fake timers, empty store/toasts/shortcuts/storage (and what the setup card and the mini timelines
 * remember for the session), hash at the Dashboard, a fresh mock bridge.
 */
export function setUp(opts: InstallOptions = {}): MockDimFactory {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date(2026, 9, 6, 15, 0, 0))
  resetStore()
  clearToasts()
  resetShortcuts()
  resetTicker()
  resetSetupStateForTests()
  resetMiniTimelineForTests()
  setMacForTests(false)
  clearStorage()
  window.location.hash = ''
  return installMockDimFactory(opts)
}

/** afterEach. */
export function tearDown(mock: MockDimFactory): void {
  cancelRefetches()
  resetShortcuts()
  resetTicker()
  clearToasts()
  setMacForTests(null)
  mock.uninstall()
  vi.useRealTimers()
  window.location.hash = ''
  clearStorage()
}

/** Let pending IPC replies and effects settle (fake timers, so advance by 0 a few times). */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  })
}

const pass = (vendor: string, model: string | null, enabled = true) => ({
  vendor,
  model,
  mode: 'readonly' as const,
  enabled,
})

/** The parts of config.resolve's reply the composer reads (the rest of ResolvedConfig is not used there). */
export function resolvedView(
  over: { profile?: string; auto?: boolean; profiles?: string[]; disabled?: PassName[] } = {},
): ResolvedWithProvenance {
  const off = new Set(over.disabled ?? [])
  return {
    config: {
      profile: over.profile ?? 'claude-only',
      auto: over.auto ?? false,
      passes: {
        plan: pass('claude', 'opus', !off.has('plan')),
        implement: { ...pass('claude', null, !off.has('implement')), mode: 'autoedit' },
        review: pass('claude', 'sonnet', !off.has('review')),
        critic: pass('claude', 'opus', !off.has('critic')),
        fix: { ...pass('claude', null, !off.has('fix')), mode: 'autoedit' },
      },
    },
    provenance: {},
    issues: [],
    layers: {
      user: { scope: 'user', path: 'C:\\home\\dimfactory.json', exists: true, sha256: null, valid: true },
    },
    scopeRoot: null,
    folderKey: null,
    ...(over.profiles !== undefined ? { profiles: over.profiles } : {}),
  } as unknown as ResolvedWithProvenance
}

export function probeView(vendor: string, health: VendorHealth, over: Partial<ProbeView> = {}): ProbeView {
  const name = vendor.charAt(0).toUpperCase() + vendor.slice(1)
  return {
    vendor,
    displayName: name,
    built: true,
    experimental: false,
    health,
    healthDetail: health === 'ready' ? 'Ready' : 'Login needed',
    checking: false,
    versionFloor: '2.0.0',
    versionRecommended: null,
    testedUpTo: '2.3.0',
    probe: null,
    candidates: [],
    ...over,
  }
}
