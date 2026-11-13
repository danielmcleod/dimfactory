// Outside agents' settings in DIM_FACTORY_HOME/state.json: `externalMcp: {enabled, port, token}`. Off by default; the
// token is made the first time access is turned on and kept (so a client set up once keeps working) until the user
// asks for a new one. Other state.json fields are kept as they are; writes go through the one serialized state.json
// writer (store/state-file.ts), shared with main's state store, the catalog and first launch.
import { updateStateFile } from '../store/state-file.ts'
import { isPlainObject, readVersionedJson } from '../store/versions.ts'

export const DEFAULT_MCP_PORT = 47821

export interface ExternalMcpState {
  enabled: boolean
  port: number
  token: string | null
}

export const DEFAULT_EXTERNAL_MCP: ExternalMcpState = { enabled: false, port: DEFAULT_MCP_PORT, token: null }

const validPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535
/** A token Dim Factory wrote: base64url, 32 to 128 characters. */
const validToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(v)

/** The externalMcp view of a raw state.json object, defaults for anything missing or malformed. */
export function externalMcpOf(raw: unknown): ExternalMcpState {
  const ext = isPlainObject(raw) && isPlainObject(raw['externalMcp']) ? raw['externalMcp'] : {}
  return {
    enabled: ext['enabled'] === true,
    port: validPort(ext['port']) ? ext['port'] : DEFAULT_MCP_PORT,
    token: validToken(ext['token']) ? ext['token'] : null,
  }
}

export interface ExternalMcpStateStore {
  get(): Promise<ExternalMcpState>
  set(patch: Partial<ExternalMcpState>): Promise<ExternalMcpState>
}

async function readRaw(file: string): Promise<Record<string, unknown>> {
  const r = await readVersionedJson<Record<string, unknown>>(file)
  return r.kind === 'ok' ? r.value : {}
}

export function createExternalMcpStateStore(stateFile: string): ExternalMcpStateStore {
  return {
    get: async () => externalMcpOf(await readRaw(stateFile)),
    // updateStateFile refuses (NEWER_SCHEMA) a state.json a newer Dim Factory wrote.
    set: (patch) =>
      updateStateFile(stateFile, (raw) => {
        const next: ExternalMcpState = { ...externalMcpOf(raw), ...patch }
        return { next: { ...raw, externalMcp: next }, value: next }
      }),
  }
}
