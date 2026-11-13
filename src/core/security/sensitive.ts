// Whether a run's changes touch code that handles keys, sign-in, payments or people's data, read from its patch with
// no model: the added lines and the paths they are in. A security advisor set to review only such changes
// (`passes.security.review: 'sensitive'`) runs its reviewer when this says so; the secret scan runs either way.

/** Added code that reaches keys, the network, accounts, payments, storage or personal fields. */
const SENSITIVE_CODE: readonly RegExp[] = [
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret)\b/i,
  /\bauthorization\b|\bbearer\s/i,
  /\bprocess\.env\b|\bimport\.meta\.env\b|\b(?:VITE|NEXT_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]+/,
  /\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnavigator\.sendBeacon\b/,
  /\b(?:supabase|firebase|firestore|stripe|paypal|auth0|clerk|openai|anthropic)\b/i,
  /\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/,
  /\bnavigator\.geolocation\b|\bgetUserMedia\b/,
  /<form\b|\bFormData\b|type=["'](?:email|tel|password)["']/i,
  /\b(?:email|e-mail|phone|telephone|address|postcode|zip ?code|birth ?date|date ?of ?birth|ssn|passport)\s*[:=,]/i,
]

/** Paths whose change is sensitive by itself: settings with keys, data files, server functions. */
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env[^/]*|netlify\/functions\/|functions\/|api\/|server\/|supabase\/|data\/[^/]+\.(?:csv|tsv|json|xlsx?))/i

/** A git patch's changed paths and added lines (zero context is enough). */
function addedByFile(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let file: string | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      file = p === '/dev/null' ? null : p.replace(/^b\//, '')
      if (file !== null && !out.has(file)) out.set(file, [])
      continue
    }
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line)
      file = m?.[1] ?? null
      if (file !== null && !out.has(file)) out.set(file, [])
      continue
    }
    if (file !== null && line.startsWith('+') && !line.startsWith('+++')) out.get(file)?.push(line.slice(1))
  }
  return out
}

/** The patch touches code that handles keys, sign-in, payments or people's data. */
export function sensitiveChange(patch: string): boolean {
  for (const [file, lines] of addedByFile(patch)) {
    if (SENSITIVE_PATH.test(file)) return true
    for (const l of lines) if (SENSITIVE_CODE.some((re) => re.test(l))) return true
  }
  return false
}
