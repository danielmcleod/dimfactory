// vendorSetup's own guards (only the unelevated setup runs from Dim Factory; the
// elevated one stays a copied command). The setup itself over a private app-server is replayed from X11b / X11c in
// tests/integration/codex/adapter/replay.test.ts.
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createCodexAdapter } from '@core/adapters/codex/index.ts'
import { runSandboxSetup } from '@core/adapters/codex/setup.ts'
import type { ResolveResult } from '@core/proc/resolve-cli.ts'

const noBinary = (): Promise<ResolveResult> => Promise.resolve({ ok: false, rejected: [], candidates: [] })

describe('vendorSetup guards', () => {
  const adapter = createCodexAdapter({ env: {}, home: tmpdir(), platform: 'win32', resolve: noBinary })
  const signal = new AbortController().signal

  it('refuses the elevated setup and anything but the mode', async () => {
    await expect(
      adapter.vendorSetup('windowsSandbox/setupStart', { mode: 'elevated' }, signal),
    ).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/no administrator rights/) as string,
    })
    await expect(
      adapter.vendorSetup('windowsSandbox/setupStart', { mode: 'unelevated', cwd: 'C:\\' }, signal),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      adapter.vendorSetup(
        'windowsSandbox/nope' as 'windowsSandbox/setupStart',
        { mode: 'unelevated' },
        signal,
      ),
    ).resolves.toMatchObject({ ok: false })
  })

  it('a missing Codex is an error the executor reports (nothing is spawned)', async () => {
    await expect(
      adapter.vendorSetup('windowsSandbox/setupStart', { mode: 'unelevated' }, signal),
    ).rejects.toThrow(/not installed/)
  })

  it('off Windows there is no sandbox to set up', async () => {
    await expect(
      runSandboxSetup({
        cli: { command: 'codex', prefixArgs: [] },
        args: [],
        env: {},
        cwd: tmpdir(),
        signal,
        platform: 'linux',
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ ok: false, detail: 'The Codex Windows sandbox exists only on Windows.' })
  })
})
