// Try it for me in the real app (Electron): the hidden window walks a page, says what each press broke, leaves out paying
// and deleting, and a press that would leave for another app goes nowhere. An inert scheme stands in for a mail link, so a
// miss here opens nothing on this computer.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'

const PAGE = `<!doctype html><title>Walk</title><body>
<h1>Walk me</h1>
<button onclick="document.getElementById('out').textContent = 'hello'">Say hello</button>
<button onclick="throw new Error('the broken button')">Broken button</button>
<button onclick="location.href = 'dfbenchinert:mail?to=a'">Email us</button>
<button onclick="document.body.textContent = 'deleted'">Delete everything</button>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'thanks ' + this.who.value">
  <input name="who"><button type="submit">Send it</button>
</form>
<p id="out"></p>
</body>`

test('Try it for me walks a page, names what broke and leaves out what is risky', async ({ e2e }) => {
  test.setTimeout(180_000)
  await e2e.start()
  writeFileSync(join(e2e.sandbox, 'index.html'), PAGE)
  const info = await e2e.call('preview.detect', { folder: e2e.sandbox })
  const stat = info.commands.find((c) => c.kind === 'static')
  expect(stat).toBeDefined()
  const session = await e2e.call('preview.start', { folder: e2e.sandbox, commandId: stat?.id ?? '' })

  const r = await e2e.call('preview.tryIt', { sessionId: session.id })
  expect(r.loaded).toBe(true)
  expect(r.steps.map((s) => s.did)).toEqual(['Say hello', 'Broken button', 'Email us', 'Send it'])
  expect(r.skipped).toEqual(['Delete everything'])
  const broken = r.steps.find((s) => s.did === 'Broken button')
  expect(broken?.problems.join(' ')).toContain('the broken button')
  expect(r.steps.find((s) => s.did === 'Say hello')?.problems).toEqual([])
  expect(r.steps.find((s) => s.did === 'Send it')?.problems).toEqual([])

  await e2e.call('preview.stop', { sessionId: session.id })
  expect(e2e.pageErrors).toEqual([])
})
