// A small ZIP writer and reader for the upload file (deploy/upload.ts): deflate or store per file, UTF-8 names, a
// comment that marks the file as made by Dim Factory, no ZIP64 (the upload file's caps keep it far below 4 GB). The
// writer streams to a temporary file next to the target and renames it into place, so a half-written zip is never
// left under the real name. The reader lists a zip's entries and comment from its central directory (tests, and the
// check that an existing file of the same name is a previous upload file before it is replaced).
import { open, readFile, rename, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { crc32, deflateRaw } from 'node:zlib'

const deflate = promisify(deflateRaw)

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
/** Bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800
const MAX_32 = 0xffffffff
const MAX_ENTRIES = 0xffff

export interface ZipInput {
  /** The name in the zip (`/` separators, no leading slash). */
  name: string
  data: Buffer
  mtime: Date
}

interface Central {
  name: Buffer
  crc: number
  method: number
  compressed: number
  size: number
  offset: number
  time: number
  date: number
}

/** MS-DOS time and date (local time, 2-second steps; dates before 1980 become 1980-01-01). */
function dosDateTime(d: Date): { time: number; date: number } {
  const y = d.getFullYear()
  if (y < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(y, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** A zip being written: add files one at a time, then finish (or abort). */
export class ZipWriter {
  readonly #tmp: string
  readonly #target: string
  #fh: Awaited<ReturnType<typeof open>> | undefined
  #offset = 0
  readonly #central: Central[] = []

  private constructor(target: string, tmp: string) {
    this.#target = target
    this.#tmp = tmp
  }

  static async create(target: string): Promise<ZipWriter> {
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.partial`
    const w = new ZipWriter(target, tmp)
    w.#fh = await open(tmp, 'wx', 0o644)
    return w
  }

  async #write(buf: Buffer): Promise<void> {
    if (this.#fh === undefined) throw new Error('The zip is closed.')
    let done = 0
    while (done < buf.length) {
      const { bytesWritten } = await this.#fh.write(buf, done, buf.length - done)
      done += bytesWritten
    }
    this.#offset += buf.length
  }

  async add(f: ZipInput): Promise<void> {
    if (this.#central.length >= MAX_ENTRIES) throw new Error('Too many files for one zip.')
    const name = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const packed = f.data.length > 0 ? await deflate(f.data, { level: 9 }) : Buffer.alloc(0)
    // Stored when deflate does not help (images, fonts, already-compressed files).
    const method = packed.length < f.data.length ? 8 : 0
    const body = method === 8 ? packed : f.data
    if (this.#offset + body.length + 30 + name.length > MAX_32 || f.data.length > MAX_32)
      throw new Error('The zip would be too large.')
    const { time, date } = dosDateTime(f.mtime)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(LOCAL_SIG, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(UTF8_FLAG, 6)
    h.writeUInt16LE(method, 8)
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(date, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(body.length, 18)
    h.writeUInt32LE(f.data.length, 22)
    h.writeUInt16LE(name.length, 26)
    h.writeUInt16LE(0, 28)
    const offset = this.#offset
    await this.#write(h)
    await this.#write(name)
    await this.#write(body)
    this.#central.push({
      name,
      crc,
      method,
      compressed: body.length,
      size: f.data.length,
      offset,
      time,
      date,
    })
  }

  /** Write the central directory with `comment`, close, and move the file to its real name. */
  async finish(comment: string): Promise<void> {
    const start = this.#offset
    for (const c of this.#central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(CENTRAL_SIG, 0)
      h.writeUInt16LE(20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(UTF8_FLAG, 8)
      h.writeUInt16LE(c.method, 10)
      h.writeUInt16LE(c.time, 12)
      h.writeUInt16LE(c.date, 14)
      h.writeUInt32LE(c.crc, 16)
      h.writeUInt32LE(c.compressed, 20)
      h.writeUInt32LE(c.size, 24)
      h.writeUInt16LE(c.name.length, 28)
      // Extra, comment, disk, internal attributes: none.
      h.writeUInt32LE(0, 38)
      h.writeUInt32LE(c.offset, 42)
      await this.#write(h)
      await this.#write(c.name)
    }
    const text = Buffer.from(comment, 'utf8').subarray(0, 0xffff)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_SIG, 0)
    end.writeUInt16LE(this.#central.length, 8)
    end.writeUInt16LE(this.#central.length, 10)
    end.writeUInt32LE(this.#offset - start, 12)
    end.writeUInt32LE(start, 16)
    end.writeUInt16LE(text.length, 20)
    await this.#write(end)
    await this.#write(text)
    await this.#fh?.close()
    this.#fh = undefined
    await rename(this.#tmp, this.#target)
  }

  /** Close and delete the temporary file (the target is left as it was). */
  async abort(): Promise<void> {
    await this.#fh?.close().catch(() => undefined)
    this.#fh = undefined
    await rm(this.#tmp, { force: true }).catch(() => undefined)
  }
}

export interface ZipEntry {
  name: string
  size: number
  compressed: number
  method: number
  crc: number
  offset: number
}

/** The end-of-central-directory record's offset in `buf` (-1: not a zip). */
function endRecord(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i
  }
  return -1
}

/** A zip's entries and comment, from its central directory (null: not a zip this reader understands). */
export function readZip(buf: Buffer): { entries: ZipEntry[]; comment: string } | null {
  if (buf.length < 22) return null
  const end = endRecord(buf)
  if (end < 0) return null
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) return null
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, comment: buf.subarray(end + 22).toString('utf8') }
}

/** A zip file's comment, from its last 64 KB only (null: missing, unreadable or not a zip). */
export async function readZipComment(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, 'r')
    const size = (await fh.stat()).size
    const len = Math.min(size, 22 + 0xffff)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const end = endRecord(buf)
    return end < 0 ? null : buf.subarray(end + 22).toString('utf8')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/** A zip file's entries and comment (null: missing or not a zip). */
export async function readZipFile(path: string): Promise<{ entries: ZipEntry[]; comment: string } | null> {
  try {
    return readZip(await readFile(path))
  } catch {
    return null
  }
}
