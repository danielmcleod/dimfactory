// Declarations for scripts/gen-codex-types.mjs (the generated Codex protocol types).

/** `codex-cli 0.160.1` → `0.160.1` (a prerelease suffix is kept); null when the text is not a Codex version line. */
export function parseCodexVersion(text: string): string | null

export interface MethodsInventory {
  clientRequests: { method: string; experimental: boolean }[]
  clientNotifications: { method: string; experimental: boolean }[]
  serverRequests: { method: string; experimental: boolean }[]
  serverNotifications: { method: string; experimental: boolean }[]
  fields: Record<string, { name: string; experimental: boolean }[]>
}

/** Every method by direction; `experimental` = absent from the stable (non --experimental) schema. */
export function methodsInventory(bundle: unknown, stable: unknown): MethodsInventory

/** sha256 over a generated folder but meta.json. */
export function contentHash(dir: string): string

export interface CompareResult {
  different: boolean
  breaking: boolean
  files: { added: string[]; removed: string[]; changed: string[] }
  methods: { added: string[]; removed: string[] }
  missingRequired: string[]
  newShapeProblems: string[]
  watchedChanged: string[]
}

/** Committed folder vs freshly generated output. */
export function compareGenerated(committedDir: string, generatedDir: string): CompareResult

export function reportMarkdown(
  r: CompareResult,
  o: { cliVersion: string; committedVersion: string; folder: string },
): string
