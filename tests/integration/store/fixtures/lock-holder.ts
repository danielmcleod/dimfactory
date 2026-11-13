// Child process that takes the home lock (real stale detection deps) and holds it until killed.
import { acquireHomeLock } from '../../../../src/core/store/home-lock.ts'

const [home] = process.argv.slice(2)
if (home === undefined) throw new Error('usage: lock-holder <home>')
const lock = await acquireHomeLock(home, { kind: 'app' })
process.stdout.write(`locked ${lock.info.pid} ${lock.info.startMs}\n`)
setInterval(() => undefined, 60_000)
