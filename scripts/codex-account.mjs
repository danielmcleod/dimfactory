// Which Codex account is signed in, and how much of its allowance is used (dev helper). Asks the local Codex
// app-server three read-only questions (account/read, account/rateLimits/read, account/usage/read): no model call,
// no tokens, nothing written. It never opens Codex's credential file and prints no tokens.
//   node scripts/codex-account.mjs            (uses CODEX_HOME, else ~/.codex)
//   node scripts/codex-account.mjs --bin "C:\path\to\codex.exe"
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const argBin = process.argv.indexOf('--bin')
const known = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
const bin = argBin !== -1 ? process.argv[argBin + 1] : existsSync(known) ? known : 'codex'

const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
})
const pending = new Map()
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line === '') continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
let next = 1
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = next++
    pending.set(id, resolve)
    send(params === undefined ? { id, method } : { id, method, params })
  })
const timer = setTimeout(() => {
  console.error('No answer from Codex within 30 s.')
  child.kill()
  process.exit(1)
}, 30_000)

const init = await ask('initialize', {
  clientInfo: { name: 'dim-factory-account-check', title: null, version: '0.0.1' },
  capabilities: { experimentalApi: false, requestAttestation: false },
})
if (init.error) {
  console.error('Codex refused the handshake:', init.error.message)
  process.exit(1)
}
send({ method: 'initialized' })

const account = await ask('account/read', { refreshToken: false })
const limits = await ask('account/rateLimits/read')
const usage = await ask('account/usage/read', {})

const a = account.result?.account
console.log('Codex:', bin)
if (!a) console.log('Account: not signed in')
else if (a.type === 'chatgpt')
  console.log(`Account: ChatGPT login, ${a.email ?? '(email not reported)'}, plan: ${a.planType}`)
else if (a.type === 'apiKey') console.log('Account: an OpenAI API KEY (usage is billed to that API account)')
else console.log(`Account: ${a.type}`)
if (account.error) console.log('account/read:', account.error.message)

const rl = limits.result?.rateLimits
if (rl) {
  const win = (w) =>
    w ? `${w.usedPercent}% used of a ${Math.round(w.windowDurationMins / 1440)}-day window` : 'none'
  console.log(`Allowance: ${win(rl.primary)}${rl.secondary ? `; second window ${win(rl.secondary)}` : ''}`)
  console.log(
    `Paid credits: ${rl.credits?.hasCredits ? `yes (balance ${rl.credits.balance ?? 'unknown'})` : 'none'}`,
  )
} else if (limits.error) console.log('account/rateLimits/read:', limits.error.message)

const days = usage.result?.dailyUsageBuckets
if (Array.isArray(days) && days.length > 0) {
  console.log('Tokens by day (Codex estimate):')
  for (const d of days.slice(-7)) console.log(`  ${d.startDate}  ${d.tokens}`)
} else if (usage.error) console.log('account/usage/read:', usage.error.message)

clearTimeout(timer)
child.stdin.end()
child.kill()
