// Declarations for scripts/scan-profile-leaks.mjs (the review scan before live data is committed).

/** The time a UUIDv7 carries (ms), or undefined for another version. */
export function uuidV7Ms(id: string): number | undefined

/** The profile's own ids: the UUIDs in session_index.jsonl and installation_id (`since`: a v7 id from then on is skipped). */
export function profileIds(codexHome: string, since?: number): string[]

export interface ScanMatcher {
  kind:
    'profile-id' | 'profile-term' | 'profile-name' | 'claude-term' | 'claude-name' | 'user-name' | 'host-name'
  re: RegExp
}
export function scanMatchers(o: {
  codexHome?: string | undefined
  /** A Claude config folder whose terms (and, with names, its names) are looked for. */
  claudeConfig?: string | undefined
  since?: number | undefined
  names?: boolean
  home?: string
  user?: string
  host?: string
}): ScanMatcher[]

export interface ScanFound {
  file: string
  kind: ScanMatcher['kind']
  count: number
}
/** Counts per file and kind of what `matchers` find under `paths` (relative to `root`). */
export function scanFiles(
  root: string,
  paths: readonly string[],
  matchers: readonly ScanMatcher[],
): { scanned: number; found: ScanFound[] }
