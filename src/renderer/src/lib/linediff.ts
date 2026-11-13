// Line diff (Myers O(ND)) → unified-style hunks with context and added/removed counts. Used by the plan gate's
// "Edited · view changes" (gate:afterPlan). Plans are small; past MAX_EDIT_DISTANCE edits
// the changed middle is shown as one replace instead of searching further.

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line in the old text (context and del). */
  oldNo?: number
  /** 1-based line in the new text (context and add). */
  newNo?: number
}

export interface DiffHunk {
  /** 1-based, as in `@@ -oldStart,oldLines +newStart,newLines @@`. */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface LineDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
  identical: boolean
}

export const MAX_EDIT_DISTANCE = 1000

type Op = 'eq' | 'del' | 'add'

/** Lines of a text; CRLF and LF are the same line break, and a final newline does not add an empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Edit script between a and b (inclusive of the common parts), or null past `maxD` edits. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(maxD, n + m)
  const off = limit + 1
  const v = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))
          ? (v[off + k + 1] ?? 0)
          : (v[off + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m, off)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number, off: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as Int32Array
    const k = x - y
    const prevK = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0)) ? k + 1 : k - 1
    const prevX = v[off + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('eq')
      x--
      y--
    }
    if (d > 0) ops.push(x === prevX ? 'add' : 'del')
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
    suf++
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  const mid = myers(midA, midB, MAX_EDIT_DISTANCE) ?? [
    ...midA.map((): Op => 'del'),
    ...midB.map((): Op => 'add'),
  ]
  return [...Array<Op>(pre).fill('eq'), ...mid, ...Array<Op>(suf).fill('eq')]
}

/** Diff two texts line by line; `context` unchanged lines surround each change (default 3). */
export function diffLines(oldText: string, newText: string, opts: { context?: number } = {}): LineDiff {
  const context = Math.max(0, opts.context ?? 3)
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = editScript(a, b)

  const all: DiffLine[] = []
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op === 'eq') {
      all.push({ kind: 'context', text: a[i] ?? '', oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (op === 'del') {
      all.push({ kind: 'del', text: a[i] ?? '', oldNo: i + 1 })
      i++
      removed++
    } else {
      all.push({ kind: 'add', text: b[j] ?? '', newNo: j + 1 })
      j++
      added++
    }
  }

  const hunks: DiffHunk[] = []
  let idx = 0
  while (idx < all.length) {
    if (all[idx]?.kind === 'context') {
      idx++
      continue
    }
    const start = Math.max(0, idx - context)
    let end = idx
    // Extend while the next change is within 2×context unchanged lines (hunks would overlap).
    for (;;) {
      while (end < all.length && all[end]?.kind !== 'context') end++
      let next = end
      while (next < all.length && all[next]?.kind === 'context') next++
      if (next < all.length && next - end <= 2 * context) end = next
      else break
    }
    const stop = Math.min(all.length, end + context)
    const lines = all.slice(start, stop)
    hunks.push(toHunk(lines, ops, start, a.length, b.length))
    idx = stop
  }
  return { hunks, added, removed, identical: added === 0 && removed === 0 }
}

function toHunk(lines: DiffLine[], ops: Op[], start: number, aLen: number, bLen: number): DiffHunk {
  let oldLines = 0
  let newLines = 0
  for (const l of lines) {
    if (l.kind !== 'add') oldLines++
    if (l.kind !== 'del') newLines++
  }
  // Position before the hunk's first line, counted from the ops (an all-add hunk still needs an old position).
  let oldPos = 0
  let newPos = 0
  for (let k = 0; k < start; k++) {
    const op = ops[k]
    if (op !== 'add') oldPos++
    if (op !== 'del') newPos++
  }
  return {
    oldStart: oldLines === 0 ? Math.min(oldPos, aLen) : oldPos + 1,
    oldLines,
    newStart: newLines === 0 ? Math.min(newPos, bLen) : newPos + 1,
    newLines,
    lines,
  }
}

/** Unified-diff text of a LineDiff (copy button, tests). */
export function formatUnified(diff: LineDiff): string {
  const out: string[] = []
  for (const h of diff.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)
  }
  return out.join('\n')
}
