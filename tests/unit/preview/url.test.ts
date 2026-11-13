// Run & Preview URL parsing: the page's loopback URL as dev servers print it, never a LAN address, a WebSocket or a
// debugger, and never a port that is not about serving.
import { describe, expect, it } from 'vitest'
import { firstPreviewUrl, parsePreviewUrl } from '../../../src/core/preview/url.ts'
import { previewOrigin, previewUrlOf } from '../../../src/shared/preview.ts'

describe('parsePreviewUrl', () => {
  it.each([
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173/'],
    [
      '\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m',
      'http://localhost:5173/',
    ],
    ['- Local:        http://localhost:3000', 'http://localhost:3000/'],
    ['INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)', 'http://127.0.0.1:8000/'],
    [' * Running on http://127.0.0.1:5000', 'http://127.0.0.1:5000/'],
    ['Starting development server at http://127.0.0.1:8000/', 'http://127.0.0.1:8000/'],
    ['[I 2026-10-24 ServerApp] http://127.0.0.1:8888/lab?token=abc', 'http://127.0.0.1:8888/lab?token=abc'],
    ['Serving HTTP on :: port 8000 (http://[::]:8000/) ...', 'http://127.0.0.1:8000/'],
    ['Server listening on port 3000', 'http://127.0.0.1:3000/'],
    ['Listening on :8080', 'http://127.0.0.1:8080/'],
    ['App running at 127.0.0.1:4000', 'http://127.0.0.1:4000/'],
    ['Open http://[::1]:9000/app.', 'http://[::1]:9000/app'],
    ['PHP 8.3 Development Server (http://127.0.0.1:8000) started', 'http://127.0.0.1:8000/'],
  ])('%s', (line, url) => {
    expect(parsePreviewUrl(line)).toBe(url)
  })

  it.each([
    ['  ➜  Network: http://192.168.1.5:5173/'],
    ['Debugger listening on ws://127.0.0.1:9229/1b2c'],
    ['[vite] connecting to ws://localhost:24678'],
    ['Error: port 3000 is already in use'],
    ['See https://example.com:8443/docs'],
    ['compiled 42 modules in 1200ms'],
    ['http://localhost:99999/'],
    ['http://user:pw@localhost:3000/'],
  ])('ignores %s', (line) => {
    expect(parsePreviewUrl(line)).toBeNull()
  })

  it('takes the first page a block of output names', () => {
    const out = [
      '> vite',
      '',
      '  VITE v7.3.7  ready in 300 ms',
      '',
      '  ➜  Local:   http://localhost:5174/',
      '  ➜  Network: use --host to expose',
    ].join('\n')
    expect(firstPreviewUrl(out)).toBe('http://localhost:5174/')
    expect(firstPreviewUrl('nothing here')).toBeNull()
  })
})

describe('previewUrlOf / previewOrigin', () => {
  it('keeps loopback http(s), reads the any address as 127.0.0.1 and refuses the rest', () => {
    expect(previewUrlOf('http://0.0.0.0:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(previewUrlOf('https://localhost:3000/')).toBe('https://localhost:3000/')
    expect(previewUrlOf('https://localhost:3000/', { httpOnly: true })).toBeNull()
    expect(previewUrlOf('http://example.com/')).toBeNull()
    expect(previewUrlOf('file:///C:/x/index.html')).toBeNull()
    expect(previewUrlOf('javascript:alert(1)')).toBeNull()
    expect(previewUrlOf('http://localhost.evil.test:3000/')).toBeNull()
    expect(previewOrigin('http://localhost:5173/a/b?c')).toBe('http://localhost:5173')
  })
})
