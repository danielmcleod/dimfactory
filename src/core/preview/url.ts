// Where a preview's page is: its loopback URL, read from the output of the command that serves it. Dev servers say it
// in many ways ("Local: http://localhost:5173/", "Listening on port 3000", "Uvicorn running on
// http://0.0.0.0:8000", "Serving HTTP on :: port 8000"); only loopback addresses are taken (a LAN address a dev
// server also prints is never opened), and a WebSocket or debugger address is never mistaken for the page.
import { previewUrlOf } from '../../shared/preview.ts'
import { cleanLine } from '../verify/excerpt.ts'

const HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])`
/** A full http(s) URL on a loopback (or any-address) host. */
const FULL_URL = new RegExp(String.raw`\bhttps?://${HOST}(?::\d{1,5})?(?:/[^\s"'<>\`)\]]*)?`, 'i')
/** `host:port` without a scheme ("Server running at 127.0.0.1:8000"). */
const HOST_PORT = new RegExp(String.raw`(?:^|[\s("'=])${HOST}:(\d{2,5})\b`, 'i')
/** "listening on port 3000", "running on :8080", "Serving HTTP on :: port 8000", "started server on 0.0.0.0, port 9000". */
const PORT_WORDS = [
  /\b(?:listening|running|serving|started|available|server|app|ready)\b[^\n]*?\bport\s*:?\s*(\d{2,5})\b/i,
  /\b(?:listening|running|serving)\b[^\n]*?\bon\s+:(\d{2,5})\b/i,
]
/** Addresses that are never the page: WebSockets (HMR, the Node inspector). */
const NOT_A_PAGE = /\bwss?:\/\/\S+/gi
/** URL punctuation a sentence may put after it. */
const TRAILING = /[.,;:!?'")\]]+$/

const portOk = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536

function fromPort(port: string | undefined): string | null {
  const p = Number(port)
  return portOk(p) ? `http://127.0.0.1:${p}/` : null
}

/** The loopback URL a line of output names, normalized (previewUrlOf), or null. */
export function parsePreviewUrl(raw: string): string | null {
  const line = cleanLine(raw).replace(NOT_A_PAGE, ' ')
  const full = FULL_URL.exec(line)
  if (full !== null) {
    const url = previewUrlOf(full[0].replace(TRAILING, ''))
    if (url !== null) {
      const port = new URL(url).port
      if (port === '' || portOk(Number(port))) return url
    }
  }
  const hp = HOST_PORT.exec(line)
  if (hp !== null) {
    const url = fromPort(hp[1])
    if (url !== null) return url
  }
  // A port alone counts only where a line also talks about serving (a "port" in an error message is not the page).
  for (const re of PORT_WORDS) {
    const m = re.exec(line)
    if (m !== null) {
      const url = fromPort(m[1])
      if (url !== null) return url
    }
  }
  return null
}

/** The first URL in a block of output (one line at a time), or null. */
export function firstPreviewUrl(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const url = parsePreviewUrl(line)
    if (url !== null) return url
  }
  return null
}
