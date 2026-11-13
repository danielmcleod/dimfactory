// The packages a manifest names, read from its text with no model call and no program run. A manifest this cannot read
// names nothing, so a broken file never reads as a new dependency.
const lower = (names: Iterable<string>): string[] =>
  [...new Set([...names].map((n) => n.toLowerCase()))].sort()

function packageJson(text: string): string[] {
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    return lower(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => {
        const deps = v[k]
        return typeof deps === 'object' && deps !== null ? Object.keys(deps) : []
      }),
    )
  } catch {
    return []
  }
}

function requirementsTxt(text: string): string[] {
  const names: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(raw.replace(/#.*$/, ''))
    if (m?.[1] !== undefined) names.push(m[1])
  }
  return lower(names)
}

function goMod(text: string): string[] {
  const names: string[] = []
  let inBlock = false
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('require (')) inBlock = true
    else if (inBlock && t === ')') inBlock = false
    else {
      const m = (inBlock ? /^(\S+)\s+v/ : /^require\s+(\S+)\s+v/).exec(t)
      if (m?.[1] !== undefined) names.push(m[1])
    }
  }
  return lower(names)
}

/** The names under TOML tables whose header matches, one `name = ...` per line. */
function tomlTableKeys(text: string, table: RegExp): string[] {
  const names: string[] = []
  let inTable = false
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('[')) inTable = table.test(t)
    else if (inTable) {
      const m = /^([A-Za-z0-9_-]+)\s*=/.exec(t)
      if (m?.[1] !== undefined) names.push(m[1])
    }
  }
  return names
}

function pyproject(text: string): string[] {
  const names = tomlTableKeys(text, /^\[tool\.poetry\.(?:dev-)?dependencies\]$/).filter((n) => n !== 'python')
  const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)
  for (const m of (list?.[1] ?? '').matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    if (m[1] !== undefined) names.push(m[1])
  }
  return lower(names)
}

const READERS: readonly [RegExp, (text: string) => string[]][] = [
  [/(^|\/)package\.json$/, packageJson],
  [/(^|\/)requirements[^/]*\.txt$/, requirementsTxt],
  [/(^|\/)go\.mod$/, goMod],
  [/(^|\/)Cargo\.toml$/, (t) => lower(tomlTableKeys(t, /^\[(?:dev-|build-)?dependencies\]$/))],
  [/(^|\/)pyproject\.toml$/, pyproject],
]

export const isManifest = (path: string): boolean => READERS.some(([re]) => re.test(path))

export function dependenciesIn(path: string, text: string): string[] {
  const reader = READERS.find(([re]) => re.test(path))
  return reader !== undefined ? reader[1](text) : []
}
