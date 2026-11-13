// "Before I share it" in plain words: each check says how it stands, what could not be checked says so, and what goes
// to a change never carries people's details.
import { describe, expect, it } from 'vitest'
import type { ShareFilesReport, SharePageReport } from '@shared/share-check.ts'
import { shareFileLines, shareFixes, sharePageLines } from '@shared/share-check.ts'

const GOOD: SharePageReport = {
  url: 'http://127.0.0.1:5000/',
  loaded: true,
  title: 'Rosie Bakes',
  image: { src: 'https://rosiebakes.example/card.png', loads: null, full: true },
  viewport: true,
  phone: { width: 390, wide: false },
  links: { checked: 3, broken: [], otherSites: 1, more: false },
  failedFiles: [],
}

const { image: _image, ...NO_IMAGE } = GOOD

const FILES: ShareFilesReport = {
  read: 4,
  truncated: false,
  secrets: [],
  publicKeys: [],
  envFiles: [],
  personal: [],
  brokenFileLinks: [],
}

const EM_DASH = String.fromCharCode(0x2014)

describe('sharePageLines', () => {
  it('a page in good shape: fine, and what it could not open is said', () => {
    const lines = sharePageLines(GOOD, null)
    expect(lines.map((l) => [l.id, l.status])).toEqual([
      ['title', 'ok'],
      ['image', 'unknown'],
      ['phone', 'ok'],
      ['links', 'ok'],
    ])
    expect(lines[1]?.text).toMatch(/not opened/)
    expect(lines[3]?.text).toMatch(/1 link to other sites was not opened/)
    expect(shareFixes(lines)).toEqual([])
  })

  it('each problem says what is wrong, and what a change should fix', () => {
    const lines = sharePageLines(
      {
        ...NO_IMAGE,
        title: 'Vite + React',
        phone: { width: 390, wide: true, part: 'a table' },
        links: { checked: 2, broken: ['/menu.html'], otherSites: 0, more: false },
        failedFiles: ['/img/hero.jpg'],
      },
      null,
    )
    expect(lines.every((l) => l.status === 'problem')).toBe(true)
    expect(lines.map((l) => l.id)).toEqual(['title', 'image', 'phone', 'links', 'files'])
    const fixes = shareFixes(lines)
    expect(fixes).toHaveLength(5)
    expect(fixes.join('\n')).toContain('/menu.html')
    expect(fixes.join('\n')).toContain('a table')
    for (const l of lines) expect(l.text).not.toContain(EM_DASH)
  })

  it('no phone setting is a problem even when it fits; a relative preview image needs its full address later', () => {
    const lines = sharePageLines(
      { ...GOOD, viewport: false, image: { src: 'card.png', loads: true, full: false } },
      null,
    )
    expect(lines.find((l) => l.id === 'phone')?.status).toBe('problem')
    expect(lines.find((l) => l.id === 'image')).toMatchObject({ status: 'unknown' })
  })

  it('a page that did not open: one line saying what was not checked, and why', () => {
    expect(sharePageLines(null, 'Start the preview first.')).toEqual([
      {
        id: 'title',
        status: 'unknown',
        text: 'The title, preview image, phone width and links were not checked: Start the preview first.',
      },
    ])
  })
})

describe('shareFileLines', () => {
  it('clean files: fine on secrets and personal details', () => {
    expect(shareFileLines(FILES, null, false).map((l) => [l.id, l.status])).toEqual([
      ['secrets', 'ok'],
      ['personal', 'ok'],
    ])
  })

  it('secrets go to a change masked; personal details are only flagged, never sent', () => {
    const lines = shareFileLines(
      {
        ...FILES,
        secrets: ['app.js:1 GitHub token (ghp_A1…, 40 chars)'],
        envFiles: ['.env'],
        publicKeys: ['index.html:2 Google API key (AIzaSy…, 39 chars)'],
        personal: [{ file: 'index.html', line: 4, kind: 'email', masked: 'j***@gmail.com' }],
        brokenFileLinks: ['guide.md links to setup.md'],
      },
      null,
      true,
    )
    expect(lines.map((l) => [l.id, l.status])).toEqual([
      ['links', 'problem'],
      ['secrets', 'problem'],
      ['secrets', 'unknown'],
      ['personal', 'unknown'],
    ])
    const personal = lines.find((l) => l.id === 'personal')
    expect(personal?.details).toEqual(['index.html, line 4: j***@gmail.com'])
    expect(personal?.text).toMatch(/sent nowhere/)
    const fixes = shareFixes(lines).join('\n')
    expect(fixes).toContain('app.js:1 GitHub token')
    expect(fixes).toContain('.env')
    expect(fixes).toContain('guide.md links to setup.md')
    expect(fixes).not.toContain('gmail')
  })

  it('files that could not be read: said, not passed', () => {
    expect(shareFileLines(null, 'That run is not here any more.', false)).toEqual([
      {
        id: 'secrets',
        status: 'unknown',
        text: 'The files were not checked for secrets or personal details: That run is not here any more.',
      },
    ])
  })
})
