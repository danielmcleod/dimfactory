// "Before I share it", the files' half: people's email addresses and phone numbers found with their values partly hidden
// (made-up ones left out), a document's links to files that are not there, and the secret scanner over the files an
// upload would carry (hidden files and lockfiles left out, a .env file named without being read out).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileLinksIn, linkTarget, personalDataIn, shareFiles } from '@core/easy/share-files.ts'

// Built at run time so this file holds no token a scanner would flag.
const TOKEN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('')
const GOOGLE_KEY = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('')

describe('personalDataIn', () => {
  it('finds real addresses and numbers, partly hidden, one line each', () => {
    const text = [
      '<p>Write to <a href="mailto:jane.baker@gmail.com">jane.baker@gmail.com</a></p>',
      '<p>Call <a href="tel:+447911123456">+44 7911 123456</a></p>',
      'Office: (415) 867-5309',
      'UK: 020 3946 1234',
    ].join('\n')
    expect(personalDataIn('index.html', text)).toEqual([
      { file: 'index.html', line: 1, kind: 'email', masked: 'j***@gmail.com' },
      { file: 'index.html', line: 2, kind: 'phone', masked: '+**********56' },
      { file: 'index.html', line: 3, kind: 'phone', masked: '(***) ***-**09' },
      { file: 'index.html', line: 4, kind: 'phone', masked: '*** **** **34' },
    ])
  })

  it('leaves out made-up and look-alike values', () => {
    const text = [
      'sam@example.com you@yourdomain.com hello@site.test noreply@company.com',
      'logo@2x.png "react@18.3.1" git@github.com:me/repo.git',
      'Call (555) 555-0123 or +1 555 0100 or 07700 900123',
      'viewBox="0 0 1200 800" width: 1920 1080; date 2026-11-05; v1.2.3.4',
    ].join('\n')
    expect(personalDataIn('index.html', text)).toEqual([])
  })
})

describe("a document's links", () => {
  it('reads Markdown and HTML links to its own files only', () => {
    expect(
      fileLinksIn(
        'docs/guide.md',
        '[Setup](setup.md) [Web](https://x.org) [Top](#top) [Mail](mailto:a@b.c) [Pic](<img/a b.png> "t")',
      ),
    ).toEqual(['setup.md', 'img/a b.png'])
    expect(fileLinksIn('index.html', '<a href="about.html#team">x</a><img src="/img/logo.png">')).toEqual([
      'about.html',
      '/img/logo.png',
    ])
    expect(fileLinksIn('notes.txt', '[a](b.md)')).toEqual([])
  })

  it('resolves from the file, the top for a leading slash, and refuses to leave the project', () => {
    expect(linkTarget('docs/guide.md', 'setup.md')).toBe('docs/setup.md')
    expect(linkTarget('docs/guide.md', '../README.md')).toBe('README.md')
    expect(linkTarget('docs/guide.md', '/img/a%20b.png')).toBe('img/a b.png')
    expect(linkTarget('guide.md', '../../outside.md')).toBeNull()
  })
})

describe('shareFiles', () => {
  it('reads what would be shared: secrets, keys meant for pages, .env files, personal details, broken links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-files-'))
    mkdirSync(join(dir, 'docs'))
    mkdirSync(join(dir, '.private'))
    writeFileSync(
      join(dir, 'index.html'),
      `<p>jane.baker@gmail.com</p>\n<script>const k = "${GOOGLE_KEY}"</script>`,
    )
    writeFileSync(join(dir, 'app.js'), `const token = "${TOKEN}"\n`)
    writeFileSync(join(dir, 'docs', 'guide.md'), '[Setup](setup.md) [Home](../index.html)')
    writeFileSync(join(dir, '.env'), `TOKEN=${TOKEN}\n`)
    writeFileSync(join(dir, '.private', 'notes.md'), 'owner@gmail.com')
    writeFileSync(join(dir, 'package-lock.json'), '{"author": "dev@gmail.com"}')
    const r = await shareFiles(dir)
    expect(r.read).toBe(3)
    expect(r.envFiles).toEqual(['.env'])
    expect(r.secrets).toHaveLength(1)
    expect(r.secrets[0]).toMatch(/^app\.js:1 /)
    expect(r.secrets.join(' ')).not.toContain(TOKEN)
    expect(r.publicKeys).toHaveLength(1)
    expect(r.personal).toEqual([{ file: 'index.html', line: 1, kind: 'email', masked: 'j***@gmail.com' }])
    expect(r.brokenFileLinks).toEqual(['docs/guide.md links to setup.md'])
  })
})
