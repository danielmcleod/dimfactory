// Child process for the crash test: emits text + events into one run as fast as it can, printing the last seq
// after every bus.sync(), until the parent kills it (SIGKILL / TerminateProcess).
import { EventBus } from '../../../../src/core/bus/bus.ts'

const [home, runId] = process.argv.slice(2)
if (home === undefined || runId === undefined) throw new Error('usage: bus-writer <home> <runId>')

const bus = new EventBus({ home, app: 'crash-test' })
await bus.openRun(runId)
let files = 0
for (;;) {
  for (let i = 0; i < 40; i++) {
    bus.pass(runId, 'implement', 1, { type: 'text', delta: 'x'.repeat(300) })
    bus.emit(runId, { t: 'diff-stats', files: ++files, added: i, deleted: 0, live: true })
  }
  await bus.sync(runId)
  process.stdout.write(`synced ${bus.lastSeq(runId) ?? 0}\n`)
}
