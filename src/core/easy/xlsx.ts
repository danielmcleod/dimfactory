// An Excel workbook's first sheet as CSV, read offline with no library: an .xlsx file is a zip of XML parts, so this
// reads the zip's central directory (deploy/zip.ts), inflates the parts it needs with node:zlib, and reads the sheet's cells (shared
// strings, inline strings, numbers, true/false). Formulas give their saved value; dates stay the numbers Excel keeps
// (days since 1900), and the report says so. Anything it cannot read (zip64, encryption, a missing part) is an error,
// and the caller then says to save the sheet as CSV instead.
import { inflateRawSync } from 'node:zlib'
import { readZip } from '../deploy/zip.ts'

/** The most cells read from one sheet (a bigger sheet is cut, and says so). */
export const XLSX_MAX_CELLS = 2_000_000

const LOCAL = 0x04034b50

interface Entry {
  name: string
  method: number
  compressed: number
  offset: number
}

/** The zip's entries by name (deploy/zip.ts reads the central directory). */
function entries(buf: Buffer): Map<string, Entry> {
  const zip = readZip(buf)
  if (zip === null) throw new Error('This is not a readable .xlsx file.')
  return new Map(zip.entries.map((e) => [e.name, e]))
}

/** One part's text (stored or deflated). */
function part(buf: Buffer, e: Entry): string {
  const at = e.offset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new Error('This .xlsx file is damaged.')
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const raw = buf.subarray(start, start + e.compressed)
  if (e.method === 0) return raw.toString('utf8')
  if (e.method === 8) return inflateRawSync(raw).toString('utf8')
  throw new Error('This workbook uses a compression this app cannot read.')
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML text with its entities read (`&amp;`, `&#10;`, `&#x41;`). */
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Every `<t>` text inside an XML fragment, joined (a rich-text string is several runs). */
function texts(xml: string): string {
  let out = ''
  // Phonetic guides (Japanese furigana) are not part of the cell's text.
  const plain = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')
  for (const m of plain.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g))
    out += xmlText(m[1] ?? '')
  return out
}

/** The workbook's shared strings, in order. */
function sharedStrings(xml: string | null): string[] {
  if (xml === null) return []
  return [...xml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) =>
    texts(m[1] ?? ''),
  )
}

/** The first sheet's part name, from the workbook and its relationships (else the usual name). */
function firstSheet(files: Map<string, Entry>, buf: Buffer): string {
  const wb = files.get('xl/workbook.xml')
  const rels = files.get('xl/_rels/workbook.xml.rels')
  if (wb !== undefined && rels !== undefined) {
    const sheet = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(part(buf, wb))
    const id = sheet?.[1]
    if (id !== undefined) {
      for (const m of part(buf, rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const attrs = m[1] ?? ''
        if (new RegExp(`\\bId="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(attrs)) {
          const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1]
          if (target !== undefined) {
            const t = target.replace(/^\//, '')
            return t.startsWith('xl/') ? t : `xl/${t}`
          }
        }
      }
    }
  }
  if (files.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml'
  throw new Error('This workbook has no sheet to read.')
}

/** A column's index from a cell reference (`C7` → 2). */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** One CSV field: quoted when it holds a comma, a quote or a line break. */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export interface SheetCsv {
  csv: string
  rows: number
  /** The sheet had more cells than XLSX_MAX_CELLS: the CSV holds the first ones. */
  cut: boolean
}

/** The first sheet of an .xlsx workbook as CSV text (rows in order; empty cells kept as empty fields). */
export function xlsxToCsv(buf: Buffer): SheetCsv {
  const files = entries(buf)
  const name = firstSheet(files, buf)
  const sheetEntry = files.get(name)
  if (sheetEntry === undefined) throw new Error('This workbook has no sheet to read.')
  const ssEntry = files.get('xl/sharedStrings.xml')
  const strings = sharedStrings(ssEntry !== undefined ? part(buf, ssEntry) : null)
  const xml = part(buf, sheetEntry)
  const rows: string[][] = []
  let cells = 0
  let cut = false
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rowNo = Number(/\br="(\d+)"/.exec(rm[1] ?? '')?.[1] ?? rows.length + 1)
    const row: string[] = []
    for (const cm of (rm[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1] ?? ''
      const body = cm[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1]
      const col = ref !== undefined ? columnOf(ref) : row.length
      const type = /\bt="(\w+)"/.exec(attrs)?.[1] ?? 'n'
      const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = strings[Number(v)] ?? ''
      else if (type === 'inlineStr') value = texts(body)
      else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : ''
      else if (v !== undefined) value = xmlText(v)
      while (row.length < col) row.push('')
      row[col] = value
      if (++cells >= XLSX_MAX_CELLS) {
        cut = true
        break
      }
    }
    // Rows the sheet skips stay as empty lines, so row numbers keep their place.
    while (rows.length < rowNo - 1) rows.push([])
    rows.push(row)
    if (cut) break
  }
  // Trailing empty rows are left out.
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((c) => c === '')) rows.pop()
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0)
  const csv = rows
    .map((r) => [...r, ...Array<string>(width - r.length).fill('')].map(csvField).join(','))
    .join('\n')
  return { csv: rows.length > 0 ? `${csv}\n` : '', rows: rows.length, cut }
}
