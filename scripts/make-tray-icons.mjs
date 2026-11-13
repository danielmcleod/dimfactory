// Generates every icon from the two SVG masters: build/logo.svg (the full-colour logo) and build/logo-tray.svg (the
// single-colour tray glyph). Pure Node, no dependencies: scripts/svg-raster.mjs rasterizes the masters, plus a minimal
// RGBA PNG encoder (zlib + CRC32), ICO and ICNS containers and a 5x7 bitmap font. Output is deterministic, so the
// committed files only change when this script or a master does.
//
//   build/icon.png                                  512 px app icon (the logo)
//   build/icon.ico                                  Windows app icon: 16 to 256 px (PNG entries)
//   build/icon.icns                                 macOS app icon: 16 to 1024 px (PNG entries)
//   build/icons/{16..512}x{16..512}.png             Linux app icons
//   build/tray/window.ico, window.png               the window's own icon on Windows and Linux (src/main/window.ts)
//   build/tray/tray-{0..9,9p}{,-attn}.png (+ @2x)   Windows/Linux tray: the glyph in navy with a lime edge, the active
//                                                   run count in lime ([_] when none), amber dot when something needs you
//   build/tray/tray{,Attn}Template.png (+ @2x)      macOS menu bar: black + alpha glyph; the count is the tray title
//   build/tray/overlay-{1..9,9p}.png (+ @2x)        Windows taskbar overlay: amber disc, dark needs-you count
//   src/renderer/public/favicon.png                 the renderer's favicon
//
// App icons up to SMALL_MAX px (title bars, small list views) are the colour tray glyph with its [_] instead of the
// logo, whose code lines turn to noise at that size; every larger one is the logo itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { fitView, flattenPath, maskOf, parseSvg, pathMasks, rgb, strokePolygons } from './svg-raster.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const LIME = rgb('#ddfe18') // the logo's outline and code
const NAVY = rgb('#1c2438') // the logo's front face: with the lime edge it reads on light and dark taskbars
const AMBER = [0xf5, 0x9e, 0x0b] // amber-500, the "needs you" dot
const BLACK = [0, 0, 0]
const INK = [0x1f, 0x29, 0x37] // gray-800: the count on the amber overlay

// ---- PNG, ICO, ICNS ------------------------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 8-bit RGBA, no interlace, filter 0 on every row. `rgba` is straight (not premultiplied) alpha. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A Windows .ico of PNG entries (Vista and later read PNG at every size). `images`: [size, png][]. */
export function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type 1: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(([size, png], k) => {
    const e = 6 + 16 * k
    header[e] = size >= 256 ? 0 : size // 0 means 256
    header[e + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, e + 4) // colour planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(png.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(([, png]) => png)])
}

/** The ICNS element types that hold a PNG, by pixel size (the @2x types reuse the larger image). */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512], // 256@2x
]

/** A macOS .icns of PNG elements. `pngOf(size)` gives the PNG at that size. */
export function encodeIcns(pngOf) {
  const elements = ICNS_TYPES.map(([type, size]) => {
    const png = pngOf(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const body = Buffer.concat(elements)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

// ---- canvas (premultiplied float RGBA, shapes sampled SS x SS per pixel) -------------------------------------

const SS = 4

class Canvas {
  constructor(size) {
    this.size = size
    this.px = new Float64Array(size * size * 4)
  }

  /** Fraction of pixel (x, y) where `inside(sx, sy)` holds, sx/sy in pixel units. */
  #coverage(x, y, inside) {
    let hits = 0
    for (let j = 0; j < SS; j++) {
      for (let i = 0; i < SS; i++) if (inside(x + (i + 0.5) / SS, y + (j + 0.5) / SS)) hits++
    }
    return hits / (SS * SS)
  }

  /** Paint `[r, g, b]` over pixel `o` (index into px) at coverage `a`. */
  #over(o, a, [r, g, b]) {
    const keep = 1 - a
    this.px[o] = (r / 255) * a + this.px[o] * keep
    this.px[o + 1] = (g / 255) * a + this.px[o + 1] * keep
    this.px[o + 2] = (b / 255) * a + this.px[o + 2] * keep
    this.px[o + 3] = a + this.px[o + 3] * keep
  }

  fill(inside, color) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const a = this.#coverage(x, y, inside)
        if (a > 0) this.#over((y * this.size + x) * 4, a, color)
      }
    }
  }

  /** Paint a sample mask (svg-raster.mjs maskOf, `ss` x `ss` samples per pixel). */
  paint(mask, ss, color) {
    const n = this.size * ss
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let hits = 0
        for (let j = 0; j < ss; j++) {
          const row = (y * ss + j) * n + x * ss
          for (let i = 0; i < ss; i++) hits += mask[row + i]
        }
        if (hits > 0) this.#over((y * this.size + x) * 4, hits / (ss * ss), color)
      }
    }
  }

  /** Punch a transparent hole (keeps the attention dot visually separate from the shape under it). */
  clear(inside) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const a = this.#coverage(x, y, inside)
        if (a === 0) continue
        const o = (y * this.size + x) * 4
        for (let k = 0; k < 4; k++) this.px[o + k] *= 1 - a
      }
    }
  }

  png() {
    const out = Buffer.alloc(this.size * this.size * 4)
    for (let i = 0; i < this.size * this.size; i++) {
      const a = this.px[i * 4 + 3]
      if (a <= 0) continue
      for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(Math.min(1, this.px[i * 4 + k] / a) * 255)
      out[i * 4 + 3] = Math.round(Math.min(1, a) * 255)
    }
    return encodePng(this.size, this.size, out)
  }
}

const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

/** Samples in `a` and not in `b`. */
const without = (a, b) => a.map((v, i) => v & (1 - b[i]))

// ---- 5x7 font -------------------------------------------------------------------------------------------------

const FONT = {
  0: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
}

/** Pixel-aligned text: glyph cells are `scale` pixels, glyphs 1 cell apart, centred horizontally. */
const text = (str, size, scale, top) => {
  const glyphs = [...str].map((ch) => FONT[ch])
  const width = (glyphs.length * 6 - 1) * scale
  const left = Math.floor((size - width) / 2)
  return (x, y) => {
    const col = Math.floor((x - left) / scale)
    const row = Math.floor((y - top) / scale)
    if (col < 0 || row < 0 || row >= 7) return false
    const g = glyphs[Math.floor(col / 6)]
    return g !== undefined && col % 6 < 5 && g[row][col % 6] === '#'
  }
}

// ---- the logo -------------------------------------------------------------------------------------------------

/** Samples per pixel side: more for small sizes, where every sample counts. */
const samplesFor = (size) => (size >= 256 ? 4 : size >= 64 ? 8 : 16)

/** Transparent margin around the logo: none at the smallest sizes, where every pixel is needed. */
const logoPad = (size) => (size <= 32 ? 0 : Math.round(size / 32))

/** The master logo at `size` px, its paths painted in document order. */
function renderLogo(master, size) {
  const ss = samplesFor(size)
  const view = fitView(master.viewBox, size, logoPad(size))
  const c = new Canvas(size)
  for (const p of master.paths) {
    if (p.masked) throw new Error('make-tray-icons: build/logo.svg must not use masks')
    if (p.inDefs) continue
    const { fill, stroke } = pathMasks(p, size, ss, view)
    const layers = [
      [fill, p.fill],
      [stroke, p.stroke],
    ]
    if (p.strokeFirst) layers.reverse()
    for (const [mask, color] of layers) if (mask !== null) c.paint(mask, ss, rgb(color))
  }
  return c.png()
}

// ---- the tray glyph -------------------------------------------------------------------------------------------

/** The tray master's silhouette and knockout as sample masks at `size` px, plus the silhouette's inner edge. */
function trayMasks(tray, size) {
  const ss = samplesFor(size)
  const view = fitView(tray.viewBox, size)
  const byId = (id) => {
    const p = tray.paths.find((q) => q.id === id)
    if (p === undefined) throw new Error(`make-tray-icons: build/logo-tray.svg has no path "${id}"`)
    return flattenPath(p.d)
  }
  const silhouette = byId('silhouette')
  const body = maskOf(
    silhouette.map((s) => s.points),
    'nonzero',
    size,
    ss,
    view,
  )
  const mark = maskOf(
    byId('mark').map((s) => s.points),
    'nonzero',
    size,
    ss,
    view,
  )
  // A stroke two grid units wide on the outline: the inner half is the 1-unit lime edge.
  const outline = maskOf(strokePolygons(silhouette, 2, 'round'), 'nonzero', size, ss, view)
  return { ss, body, mark, inner: without(body, outline) }
}

/** The attention dot: a hole in the glyph's top-right corner with a dot inside (16 px grid, scaled by `s`). */
function attentionDot(c, s, color) {
  c.clear(circle(13.5 * s, 2.5 * s, 3 * s))
  c.fill(circle(13.5 * s, 2.5 * s, 2 * s), color)
}

/** Win/Linux tray icon at 16 px (@1x) or 32 px (@2x): the glyph, and the active-run count (null: none, the [_]). */
function trayBadge(tray, label, attn, size) {
  const s = size / 16
  const m = trayMasks(tray, size)
  const c = new Canvas(size)
  c.paint(m.body, m.ss, LIME)
  c.paint(m.inner, m.ss, NAVY)
  if (label === null) c.paint(m.mark, m.ss, LIME)
  else c.fill(text(label, size, s, 7 * s), LIME)
  if (attn) attentionDot(c, s, AMBER)
  return c.png()
}

/** Windows taskbar overlay at 16 px (@1x) or 32 px (@2x): the needs-you count on an amber disc. */
function overlayBadge(label, size) {
  const s = size / 16
  const c = new Canvas(size)
  c.fill(circle(8 * s, 8 * s, 8 * s), AMBER)
  c.fill(text(label, size, s, 4 * s), INK)
  return c.png()
}

/** macOS template glyph (black + alpha); the menu bar recolours it for light/dark and highlight. */
function trayTemplate(tray, attn, size) {
  const m = trayMasks(tray, size)
  const c = new Canvas(size)
  c.paint(without(m.body, m.mark), m.ss, BLACK)
  if (attn) attentionDot(c, size / 16, BLACK)
  return c.png()
}

// ---- output ---------------------------------------------------------------------------------------------------

const SMALL_MAX = 24
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

export function generate(root = ROOT) {
  const master = parseSvg(readFileSync(join(root, 'build', 'logo.svg'), 'utf8'))
  const tray = parseSvg(readFileSync(join(root, 'build', 'logo-tray.svg'), 'utf8'))
  const trayDir = join(root, 'build', 'tray')
  const iconsDir = join(root, 'build', 'icons')
  const publicDir = join(root, 'src', 'renderer', 'public')
  for (const dir of [trayDir, iconsDir, publicDir]) mkdirSync(dir, { recursive: true })
  const written = []
  const write = (path, data) => {
    writeFileSync(path, data)
    written.push(path)
  }

  const logos = new Map()
  const logo = (size) => {
    let png = logos.get(size)
    if (png === undefined) {
      png = size <= SMALL_MAX ? trayBadge(tray, null, false, size) : renderLogo(master, size)
      logos.set(size, png)
    }
    return png
  }
  const ico = encodeIco(ICO_SIZES.map((size) => [size, logo(size)]))
  write(join(root, 'build', 'icon.png'), logo(512))
  write(join(root, 'build', 'icon.ico'), ico)
  write(join(root, 'build', 'icon.icns'), encodeIcns(logo))
  for (const size of LINUX_SIZES) write(join(iconsDir, `${size}x${size}.png`), logo(size))
  write(join(trayDir, 'window.ico'), ico)
  write(join(trayDir, 'window.png'), logo(256))
  write(join(publicDir, 'favicon.png'), logo(64))

  for (const n of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '9p']) {
    const label = n === '0' ? null : n === '9p' ? '9+' : n
    for (const attn of [false, true]) {
      const base = `tray-${n}${attn ? '-attn' : ''}`
      write(join(trayDir, `${base}.png`), trayBadge(tray, label, attn, 16))
      write(join(trayDir, `${base}@2x.png`), trayBadge(tray, label, attn, 32))
    }
  }
  for (const attn of [false, true]) {
    const base = attn ? 'trayAttnTemplate' : 'trayTemplate'
    write(join(trayDir, `${base}.png`), trayTemplate(tray, attn, 16))
    write(join(trayDir, `${base}@2x.png`), trayTemplate(tray, attn, 32))
  }
  for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9p']) {
    const label = n === '9p' ? '9+' : n
    write(join(trayDir, `overlay-${n}.png`), overlayBadge(label, 16))
    write(join(trayDir, `overlay-${n}@2x.png`), overlayBadge(label, 32))
  }
  return written
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = generate()
  console.log(`make-tray-icons: wrote ${written.length} files`)
}
