// The committed icons under build/ (scripts/make-tray-icons.mjs) match what tray-model.ts asks for: every name exists
// at 1x and @2x, is a well-formed RGBA PNG of the right size, and macOS templates are black + alpha only. The app
// icon set (ico, icns, Linux PNGs, favicon, window icon) holds every size electron-builder and the window use.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { trayIcon } from '../../../src/main/tray-model.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const TRAY_DIR = join(ROOT, 'build', 'tray')

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Decode an 8-bit RGBA, filter-0 PNG (what the generator writes), checking every chunk CRC. */
function decode(path: string): { width: number; height: number; rgba: Buffer } {
  const b = readFileSync(path)
  expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  let o = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  let ended = false
  while (o < b.length) {
    const len = b.readUInt32BE(o)
    const type = b.toString('ascii', o + 4, o + 8)
    const data = b.subarray(o + 8, o + 8 + len)
    expect(b.readUInt32BE(o + 8 + len), `${path} ${type} CRC`).toBe(crc32(b.subarray(o + 4, o + 8 + len)))
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([data[8], data[9]], 'bit depth 8, colour type RGBA').toEqual([8, 6])
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') ended = true
    o += 12 + len
  }
  expect(ended).toBe(true)
  const raw = inflateSync(Buffer.concat(idat))
  expect(raw.length).toBe((width * 4 + 1) * height)
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)], 'filter byte').toBe(0)
    raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))
  }
  return { width, height, rgba }
}

const at2x = (name: string): string => name.replace(/\.png$/, '@2x.png')

function iconNames(platform: 'win32' | 'darwin'): string[] {
  const names = new Set<string>()
  for (let active = 0; active <= 11; active++) {
    for (const needsYou of [0, 1])
      names.add(trayIcon({ activeRuns: active, needsYou, runs: [] }, platform).icon)
  }
  return [...names]
}

describe('build/tray', () => {
  it.each(iconNames('win32'))('%s exists at 16 px and 32 px (@2x) with visible pixels', (name) => {
    for (const [file, size] of [
      [name, 16],
      [at2x(name), 32],
    ] as const) {
      const path = join(TRAY_DIR, file)
      expect(existsSync(path), path).toBe(true)
      const png = decode(path)
      expect([png.width, png.height]).toEqual([size, size])
      const opaque = png.rgba.filter((_, i) => i % 4 === 3 && png.rgba[i] === 255).length
      expect(opaque).toBeGreaterThan(size * size * 0.5)
    }
  })

  it('differs between the plain and the attention variant', () => {
    expect(readFileSync(join(TRAY_DIR, 'tray-3.png'))).not.toEqual(
      readFileSync(join(TRAY_DIR, 'tray-3-attn.png')),
    )
  })

  it.each(iconNames('darwin'))('%s is a black + alpha template at 16 px and 32 px', (name) => {
    expect(name.endsWith('Template.png'), 'macOS treats *Template images as templates').toBe(true)
    for (const [file, size] of [
      [name, 16],
      [at2x(name), 32],
    ] as const) {
      const png = decode(join(TRAY_DIR, file))
      expect([png.width, png.height]).toEqual([size, size])
      let visible = 0
      for (let i = 0; i < png.rgba.length; i += 4) {
        expect([png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]]).toEqual([0, 0, 0])
        if ((png.rgba[i + 3] ?? 0) > 0) visible++
      }
      expect(visible).toBeGreaterThan(0)
    }
  })
})

/** A square PNG's pixel size, from its header. */
function pngSize(data: Buffer, name: string): number {
  expect(data.subarray(1, 4).toString('ascii'), `${name} is a PNG`).toBe('PNG')
  const width = data.readUInt32BE(16)
  expect(data.readUInt32BE(20), `${name} is square`).toBe(width)
  return width
}

describe('app icons (from build/logo.svg)', () => {
  it('build/icon.png is a 512 x 512 RGBA PNG', () => {
    const png = decode(join(ROOT, 'build', 'icon.png'))
    expect([png.width, png.height]).toEqual([512, 512])
  })

  it('build/icon.ico holds PNG entries from 16 to 256 px', () => {
    const b = readFileSync(join(ROOT, 'build', 'icon.ico'))
    expect([b.readUInt16LE(0), b.readUInt16LE(2)]).toEqual([0, 1])
    const sizes: number[] = []
    for (let k = 0; k < b.readUInt16LE(4); k++) {
      const e = 6 + 16 * k
      const size = b[e] === 0 ? 256 : (b[e] ?? -1)
      const png = b.subarray(b.readUInt32LE(e + 12), b.readUInt32LE(e + 12) + b.readUInt32LE(e + 8))
      expect(pngSize(png, `ico ${size}`)).toBe(size)
      sizes.push(size)
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]))
    expect(readFileSync(join(TRAY_DIR, 'window.ico')), 'the window icon is the app icon').toEqual(b)
  })

  it('build/icon.icns holds PNG elements from 16 to 1024 px', () => {
    const b = readFileSync(join(ROOT, 'build', 'icon.icns'))
    expect(b.toString('ascii', 0, 4)).toBe('icns')
    expect(b.readUInt32BE(4)).toBe(b.length)
    const sizes = new Set<number>()
    for (let o = 8; o < b.length;) {
      const len = b.readUInt32BE(o + 4)
      sizes.add(pngSize(b.subarray(o + 8, o + len), b.toString('ascii', o, o + 4)))
      o += len
    }
    expect([...sizes].sort((p, q) => p - q)).toEqual([16, 32, 64, 128, 256, 512, 1024])
  })

  it.each([16, 24, 32, 48, 64, 128, 256, 512])('build/icons/%ix%i.png (Linux) is that size', (size) => {
    const png = decode(join(ROOT, 'build', 'icons', `${size}x${size}.png`))
    expect([png.width, png.height]).toEqual([size, size])
  })

  it('the renderer favicon and the Linux window icon are RGBA PNGs', () => {
    expect(decode(join(ROOT, 'src', 'renderer', 'public', 'favicon.png')).width).toBe(64)
    expect(decode(join(TRAY_DIR, 'window.png')).width).toBe(256)
  })
})
