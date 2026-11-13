// Light markdown for vendor text and plans (PassCard's live stream; no heavy markdown library).
// Headings, list markers, fenced code, `code` spans and **bold**; everything else stays preformatted, wrapped text.
// Runs of plain lines stay one text node, so a long stream does not turn into thousands of elements.
import { memo } from 'react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

export type MdSegment =
  | { kind: 'plain'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; indent: string; marker: string; text: string }
  | { kind: 'code'; text: string }

const HEADING = /^(#{1,6})\s+(.*)$/
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const FENCE = /^\s*(```|~~~)/

/** Split text into segments; consecutive plain lines are merged. */
export function parseLightMarkdown(text: string): MdSegment[] {
  const out: MdSegment[] = []
  let plain: string[] = []
  let code: string[] | null = null
  const flushPlain = (): void => {
    if (plain.length > 0) out.push({ kind: 'plain', text: plain.join('\n') })
    plain = []
  }
  const lines = text.split('\n')
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (code !== null) {
      if (FENCE.test(line)) {
        out.push({ kind: 'code', text: code.join('\n') })
        code = null
      } else code.push(line)
      continue
    }
    if (FENCE.test(line)) {
      flushPlain()
      code = []
      continue
    }
    const h = HEADING.exec(line)
    if (h !== null) {
      flushPlain()
      out.push({ kind: 'heading', level: (h[1] ?? '#').length, text: h[2] ?? '' })
      continue
    }
    const l = LIST.exec(line)
    if (l !== null) {
      flushPlain()
      out.push({ kind: 'list', indent: l[1] ?? '', marker: l[2] ?? '-', text: l[3] ?? '' })
      continue
    }
    plain.push(line)
  }
  // An unclosed fence (still streaming) shows as code so far.
  if (code !== null) out.push({ kind: 'code', text: code.join('\n') })
  flushPlain()
  return out
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g

/** `code` spans and **bold** inside one segment. */
export function renderInline(text: string): ReactNode {
  if (!text.includes('`') && !text.includes('**')) return text
  const parts: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    if (at > last) parts.push(text.slice(last, at))
    const tok = m[0]
    if (tok.startsWith('`')) {
      parts.push(
        <code key={i++} className="rounded bg-muted px-1 font-mono text-[0.95em]">
          {tok.slice(1, -1)}
        </code>,
      )
    } else {
      parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>)
    }
    last = at + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const HEADING_SIZE = ['', 'text-base', 'text-[0.95rem]', 'text-sm', 'text-sm', 'text-sm', 'text-sm']

function Segment({ seg }: { seg: MdSegment }): React.JSX.Element {
  switch (seg.kind) {
    case 'plain':
      return <div>{renderInline(seg.text)}</div>
    case 'heading':
      return (
        <div className={cn('mt-1 font-semibold', HEADING_SIZE[seg.level] ?? 'text-sm')}>
          {renderInline(seg.text)}
        </div>
      )
    case 'list':
      return (
        <div className="flex gap-1.5" style={{ paddingLeft: `${Math.min(seg.indent.length, 12) * 0.5}em` }}>
          <span aria-hidden className="shrink-0 text-muted-foreground">
            {/^\d/.test(seg.marker) ? seg.marker : '•'}
          </span>
          <span className="min-w-0">{renderInline(seg.text)}</span>
        </div>
      )
    case 'code':
      return <div className="my-0.5 rounded bg-muted px-2 py-1 font-mono text-[0.95em]">{seg.text}</div>
  }
}

export const LightMarkdown = memo(function LightMarkdown({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const segs = parseLightMarkdown(text)
  return (
    <div className={cn('break-words whitespace-pre-wrap', className)}>
      {segs.map((s, i) => (
        <Segment key={i} seg={s} />
      ))}
    </div>
  )
})
