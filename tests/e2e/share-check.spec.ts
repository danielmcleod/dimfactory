// Before I share it in the real app (Electron): the hidden window reads a page at a phone's width with no internet, names
// the first part wider than the screen, opens the page's links to its own site and its preview image to see which work,
// counts the links to other sites without opening them, and lists files the page asked for that did not load. An inert
// scheme stands in for a mail link, so a miss here opens nothing on this computer.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'

const PAGE = `<!doctype html><html><head><title>Vite + React</title>
<meta property="og:image" content="card.png">
</head><body style="margin:0">
<h1>Rosie Bakes</h1>
<p><a href="about.html">About us</a> <a href="/menu/">Menu</a> <a href="missing.html">Old page</a>
<a href="about.html#team">The team</a> <a href="https://example.com/">Elsewhere</a> <a href="dfbenchinert:mail?to=a">Mail us</a>
<a href="#top">Back to top</a></p>
<div style="width:900px;background:#eee">Our big banner of fresh bread</div>
<img src="missing-picture.png" alt="">
</body></html>`

test('Before I share it reads a page at phone width and opens its own links, with no internet', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  await e2e.start()
  writeFileSync(join(e2e.sandbox, 'index.html'), PAGE)
  writeFileSync(join(e2e.sandbox, 'about.html'), '<!doctype html><title>About</title><p>About</p>')
  mkdirSync(join(e2e.sandbox, 'menu'))
  writeFileSync(join(e2e.sandbox, 'menu', 'index.html'), '<!doctype html><title>Menu</title><p>Menu</p>')
  writeFileSync(join(e2e.sandbox, 'card.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static')
  expect(stat).toBeDefined()
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })

  const r = await e2e.call('preview.shareCheck', { sessionId: session.id })
  expect(r.loaded).toBe(true)
  expect(r.title).toBe('Vite + React')
  expect(r.viewport).toBe(false)
  expect(r.phone.width).toBeLessThanOrEqual(400)
  expect(r.phone.wide).toBe(true)
  expect(r.phone.part).toBe('the part that reads "Our big banner of fresh bread"')
  expect(r.image).toEqual({ src: 'card.png', loads: true, full: false })
  // about.html once (its #team link is the same page), the menu folder, and the missing page.
  expect(r.links).toEqual({ checked: 3, broken: ['missing.html'], otherSites: 1, more: false })
  expect(r.failedFiles).toEqual(['/missing-picture.png'])

  await e2e.call('preview.stop', { sessionId: session.id })
  expect(e2e.pageErrors).toEqual([])
})
