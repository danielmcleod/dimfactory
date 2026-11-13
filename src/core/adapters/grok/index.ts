// The Grok adapter (ACP; autoedit unsupported until a fixture proves it): the Grok configuration (config.ts) on the
// ACP base. Registered in place of the
// registry's Grok stub; it is listed under "More" once its `--version` answers.
import { createAcpAdapter } from '../acp-base/index.ts'
import type { AcpAdapter, AcpAdapterOptions } from '../acp-base/index.ts'
import { registerAdapter } from '../registry.ts'
import { grokConfig } from './config.ts'

export { grokConfig } from './config.ts'
export { GROK_DISPLAY_NAME, GROK_VENDOR, grokCliSpec, parseGrokVersion } from './cli-spec.ts'

export type GrokAdapter = AcpAdapter
export type GrokAdapterOptions = AcpAdapterOptions

/**
 * `GROK_DISABLE_AUTOUPDATER=1` on every Grok process Dim Factory starts (the resolver's `--version`, the
 * probe's `agent --help` and handshake, each pass), above the user's own `vendors.grok.env`. The pass launch sets it
 * again (config.ts resolveLaunch).
 */
export function createGrokAdapter(opts: GrokAdapterOptions = {}): GrokAdapter {
  return createAcpAdapter(grokConfig, {
    ...opts,
    vendorEnv: { ...opts.vendorEnv, GROK_DISABLE_AUTOUPDATER: '1' },
  })
}

export const grokAdapter: GrokAdapter = createGrokAdapter()
registerAdapter(grokAdapter)
