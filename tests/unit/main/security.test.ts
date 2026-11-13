// installHardening (src/main/security.ts; boot step 7) against a fake `electron`: both permission handlers grant
// clipboard writes to the app's own top frame (every Copy button needs it) and deny everything else.
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

type RequestHandler = (
  wc: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { requestingUrl: string; isMainFrame: boolean },
) => void
type CheckHandler = (
  wc: { getURL(): string } | null,
  permission: string,
  origin: string,
  details: { requestingUrl?: string; isMainFrame: boolean },
) => boolean

const fake = vi.hoisted(() => ({
  request: undefined as RequestHandler | undefined,
  check: undefined as CheckHandler | undefined,
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  session: {
    defaultSession: {
      setPermissionRequestHandler: (h: RequestHandler) => (fake.request = h),
      setPermissionCheckHandler: (h: CheckHandler) => (fake.check = h),
    },
  },
}))

const { installHardening } = await import('../../../src/main/security.ts')
const { rendererTarget } = await import('../../../src/main/urls.ts')

const rendererDir = resolve('out', 'renderer')
const target = rendererTarget({ devUrl: undefined, packaged: true, rendererDir })
// The built page is app://dim-factory/index.html.
const appUrl = 'app://dim-factory/index.html#/runs/r1'

installHardening({ target, openExternal: vi.fn(), log: { warn: vi.fn() } })

function request(permission: string, requestingUrl: string, isMainFrame = true): boolean {
  let granted: boolean | undefined
  fake.request?.({}, permission, (g) => (granted = g), { requestingUrl, isMainFrame })
  if (granted === undefined) throw new Error('the request handler did not answer')
  return granted
}

describe('permission handlers', () => {
  it('grant a clipboard write requested by the app page', () => {
    expect(request('clipboard-sanitized-write', appUrl)).toBe(true)
  })

  it('deny other permissions, other pages and subframes', () => {
    expect(request('clipboard-read', appUrl)).toBe(false)
    expect(request('notifications', appUrl)).toBe(false)
    expect(request('clipboard-sanitized-write', 'https://example.com/')).toBe(false)
    expect(request('clipboard-sanitized-write', appUrl, false)).toBe(false)
  })

  it('answer checks the same way, using the page URL when a top-frame check carries none', () => {
    const wc = { getURL: () => appUrl }
    const check = fake.check
    if (check === undefined) throw new Error('no check handler')
    expect(
      check(wc, 'clipboard-sanitized-write', 'app://dim-factory', {
        requestingUrl: appUrl,
        isMainFrame: true,
      }),
    ).toBe(true)
    expect(check(wc, 'clipboard-sanitized-write', 'app://dim-factory', { isMainFrame: true })).toBe(true)
    expect(check(wc, 'clipboard-sanitized-write', 'app://dim-factory', { isMainFrame: false })).toBe(false)
    expect(check(null, 'clipboard-sanitized-write', 'app://dim-factory', { isMainFrame: true })).toBe(false)
    expect(
      check(wc, 'clipboard-read', 'app://dim-factory', { requestingUrl: appUrl, isMainFrame: true }),
    ).toBe(false)
    expect(
      check({ getURL: () => 'https://example.com/' }, 'clipboard-sanitized-write', '', { isMainFrame: true }),
    ).toBe(false)
  })
})
