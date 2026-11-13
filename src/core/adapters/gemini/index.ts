// The Gemini adapter (ACP only): the
// Gemini configuration (config.ts) on the ACP base. Registered in place of the registry's Gemini stub.
import { createAcpAdapter } from '../acp-base/index.ts'
import type { AcpAdapter, AcpAdapterOptions } from '../acp-base/index.ts'
import { registerAdapter } from '../registry.ts'
import { geminiConfig } from './config.ts'

export { geminiConfig } from './config.ts'
export { GEMINI_DISPLAY_NAME, GEMINI_VENDOR, geminiCliSpec, parseGeminiVersion } from './cli-spec.ts'

export type GeminiAdapter = AcpAdapter
export type GeminiAdapterOptions = AcpAdapterOptions

export function createGeminiAdapter(opts: GeminiAdapterOptions = {}): GeminiAdapter {
  return createAcpAdapter(geminiConfig, opts)
}

export const geminiAdapter: GeminiAdapter = createGeminiAdapter()
registerAdapter(geminiAdapter)
