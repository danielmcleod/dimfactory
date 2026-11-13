// Every file Dim Factory bundles for templates to copy carries a licence, and only a permissive one. A third-party
// entry (Phaser) has its licence file beside it, hash-checked, whose text is the licence its SPDX id names; a starter
// file (Dim Factory's own) says its licence in the file itself. A new entry with no licence, or a copyleft or unknown
// SPDX id, fails here before it can ship.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readVendorManifest } from '@core/templates/files.ts'
import { builtinTemplatesDir } from '@core/templates/load.ts'

/** Permissive SPDX ids a bundled file may carry, and a phrase its licence text must hold. */
const PERMISSIVE: Readonly<Record<string, RegExp>> = {
  MIT: /Permission is hereby granted, free of charge/,
  ISC: /Permission to use, copy, modify, and\/or distribute this software/,
  'BSD-2-Clause': /Redistribution and use in source and binary forms/,
  'BSD-3-Clause': /Redistribution and use in source and binary forms/,
  'Apache-2.0': /Apache License/,
  Zlib: /This software is provided 'as-is'/,
  '0BSD': /Permission to use, copy, modify, and\/or distribute this software/,
  'CC0-1.0': /CC0/,
}

const vendorFile = (rel: string): Buffer =>
  readFileSync(join(builtinTemplatesDir(), 'vendor', ...rel.split('/')))
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('bundled licences', () => {
  it('every entry has a permissive SPDX licence', async () => {
    const m = await readVendorManifest()
    expect(m.entries.length).toBeGreaterThan(0)
    for (const e of m.entries) {
      expect(e.license, `${e.id} has no licence`).toBeTruthy()
      expect(Object.keys(PERMISSIVE), `${e.id}: ${e.license} is not a permissive SPDX id`).toContain(
        e.license,
      )
    }
  })

  it('a third-party entry has its licence file, hash-checked, holding that licence', async () => {
    const m = await readVendorManifest()
    for (const e of m.entries) {
      if (e.origin !== 'third-party') continue
      const text = vendorFile(e.licenseFile)
      expect(sha256(text), `${e.id} licence hash`).toBe(e.licenseSha256)
      expect(text.toString('utf8'), `${e.id}: its licence file is not ${e.license}`).toMatch(
        PERMISSIVE[e.license] ?? /^$/,
      )
      expect(e.homepage).toMatch(/^https:\/\//)
      expect(e.version).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  it("a starter file says its licence in the file (Dim Factory's own, MIT)", async () => {
    const m = await readVendorManifest()
    for (const e of m.entries) {
      if (e.origin !== 'starter') continue
      expect(vendorFile(e.path).toString('utf8'), `${e.id} does not say its licence`).toMatch(/MIT License/)
    }
  })

  it('the check fails for an entry with no licence or a copyleft one', () => {
    const permissive = (id: string | undefined): boolean => id !== undefined && id in PERMISSIVE
    expect(permissive(undefined)).toBe(false)
    expect(permissive('GPL-3.0-only')).toBe(false)
    expect(permissive('AGPL-3.0')).toBe(false)
    expect(permissive('LGPL-2.1')).toBe(false)
    expect(permissive('MPL-2.0')).toBe(false)
    expect(permissive('MIT')).toBe(true)
  })
})
