// A loopback port free right now, as the OS hands one out. A port picked at random can fall in a range Windows keeps
// for itself (Hyper-V and WinNAT exclusions), where listening fails with EACCES; the OS never hands one of those out.
import { createServer } from 'node:net'

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a !== null ? a.port : 0
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('no port was handed out'))))
    })
  })
}
