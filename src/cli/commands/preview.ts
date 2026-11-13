// `dimf preview <folder>` (dev/CI): how Run & Preview would run the folder (the detected commands with their trust,
// the non-blocking tool checks, RUN.md), and with --start one of them, printing the page's URL once its output names
// it. --once stops it right after (a check that the project comes up); otherwise it runs until Ctrl+C, and is
// stopped (its process tree killed) when the CLI exits. A command runs only once trusted: --trust grants it first
// (as the app's Trust button does).
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Core } from '../../core/app-core.ts'
import type { PreviewCommand, PreviewInfo, PreviewSessionView } from '../../shared/preview.ts'
import { UsageError } from '../args.ts'
import type { CliIo } from '../io.ts'
import { EXIT, usage, withReadOnlyCore, withWritableCore } from '../session.ts'

export const PREVIEW_USAGE =
  'dimf preview <folder> [--start] [--command id] [--trust] [--once] [--wait seconds] [--json] [--home dir]'

const TRUST_TEXT: Record<PreviewCommand['trust'], string> = {
  trusted: 'trusted',
  untrusted: 'not trusted',
  changed: 'changed since trusted',
  none: '',
}

/** The detection as lines (the default command first, marked `*`). */
export function previewLines(info: PreviewInfo): string[] {
  const out: string[] = []
  if (info.commands.length === 0) {
    out.push(`No way to run ${info.folder} was found.`)
  } else {
    out.push(`Ways to run ${info.folder}:`)
    const idW = Math.max(...info.commands.map((c) => c.id.length))
    const labelW = Math.max(...info.commands.map((c) => c.label.length))
    info.commands.forEach((c, i) => {
      const trust = TRUST_TEXT[c.trust]
      out.push(
        `  ${i === 0 ? '*' : ' '} ${c.id.padEnd(idW)}  ${c.label.padEnd(labelW)}  ${c.kind.padEnd(7)}${trust !== '' ? `  ${trust}` : ''}`.trimEnd(),
      )
      if (c.urlHint !== undefined) out.push(`      expected at ${c.urlHint}`)
      if (c.error !== undefined) out.push(`      cannot run: ${c.error}`)
    })
  }
  for (const check of info.checks) out.push(`  WARN ${check.title}: ${check.detail}`)
  if (info.runMd !== null)
    out.push(`RUN.md: ${info.runMd.text.length} characters${info.runMd.truncated ? ' (cut)' : ''}`)
  else if (info.commands.length === 0) out.push('There is no RUN.md either.')
  return out
}

interface Values {
  start?: boolean | undefined
  command?: string | undefined
  trust?: boolean | undefined
  once?: boolean | undefined
  wait?: string | undefined
  json?: boolean | undefined
  home?: string | undefined
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForUrl(core: Core, id: string, waitMs: number): Promise<PreviewSessionView | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    const r = await core.invoke('preview.list')
    const s = r.ok ? r.value.find((v) => v.id === id) : undefined
    if (s === undefined || s.url !== null || s.endedAt !== undefined || Date.now() >= until) return s
    await sleep(200)
  }
}

async function runPreview(core: Core, io: CliIo, folder: string, v: Values): Promise<number> {
  const det = await core.invoke('preview.detect', { folder })
  if (!det.ok) {
    io.err(`dimf preview: ${det.error.message}`)
    return det.error.code === 'NOT_FOUND' || det.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
  }
  const info = det.value
  if (v.start !== true && v.trust !== true) {
    if (v.json === true) io.out(JSON.stringify(info, null, 2))
    else for (const l of previewLines(info)) io.out(l)
    return info.commands.length > 0 ? EXIT.completed : EXIT.failed
  }
  const cmd = v.command !== undefined ? info.commands.find((c) => c.id === v.command) : info.commands[0]
  if (cmd === undefined) {
    io.err(
      v.command !== undefined
        ? `dimf preview: no command "${v.command}" (see dimf preview ${folder})`
        : `dimf preview: no way to run ${folder} was found`,
    )
    return EXIT.failed
  }
  if (v.trust === true && cmd.kind !== 'static' && cmd.trust !== 'trusted') {
    const t = await core.invoke('preview.trust', {
      folder,
      commandId: cmd.id,
      ...(cmd.hash !== undefined ? { hash: cmd.hash } : {}),
      trusted: true,
    })
    if (!t.ok) {
      io.err(`dimf preview: ${t.error.message}`)
      return EXIT.failed
    }
    io.err(`Trusted ${cmd.label} for ${folder}.`)
  }
  const started = await core.invoke('preview.start', { folder, commandId: cmd.id })
  if (!started.ok) {
    io.err(`dimf preview: ${started.error.message}`)
    if (started.error.code === 'FORBIDDEN') io.err('Trust it in the Run it panel, or start it with --trust.')
    return EXIT.failed
  }
  io.out(`$ ${cmd.label}`)
  const waitMs = Math.max(1, Number(v.wait ?? '60')) * 1000
  const s = await waitForUrl(core, started.value.id, waitMs)
  if (s?.url != null) io.out(`URL: ${s.url}`)
  else if (s?.endedAt !== undefined) {
    for (const l of s.tail.slice(-20)) io.out(`  ${l}`)
    io.err(`dimf preview: ${s.reason ?? 'it ended'}`)
    return s.status === 'exited' ? EXIT.completed : EXIT.failed
  } else io.err(`dimf preview: no URL in its output after ${waitMs / 1000} s`)
  if (v.json === true && s !== undefined) io.out(JSON.stringify(s, null, 2))
  if (v.once === true) {
    await core.invoke('preview.stop', { sessionId: started.value.id })
    return s?.url != null ? EXIT.completed : EXIT.failed
  }
  io.err('Running. Press Ctrl+C to stop it.')
  await new Promise<void>((done) => {
    const off = io.onInterrupt(() => {
      off()
      done()
    })
    void (async () => {
      for (;;) {
        const r = await core.invoke('preview.list')
        const now = r.ok ? r.value.find((x) => x.id === started.value.id) : undefined
        if (now === undefined || now.endedAt !== undefined) {
          off()
          done()
          return
        }
        await sleep(500)
      }
    })()
  })
  await core.invoke('preview.stop', { sessionId: started.value.id })
  return EXIT.completed
}

export async function previewCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: Values
  let folder: string
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        start: { type: 'boolean', default: false },
        command: { type: 'string' },
        trust: { type: 'boolean', default: false },
        once: { type: 'boolean', default: false },
        wait: { type: 'string' },
        json: { type: 'boolean', default: false },
        home: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <folder>')
    if (v.wait !== undefined && !/^\d{1,5}$/.test(v.wait)) throw new UsageError('--wait takes whole seconds')
    folder = resolve(io.cwd, parsed.positionals[0] ?? '.')
  } catch (err) {
    return usage(io, 'preview', PREVIEW_USAGE, err)
  }
  // Granting trust writes trust.json (the writable core); detecting and starting read it only.
  const session = v.trust === true ? withWritableCore : withReadOnlyCore
  return session(io, v.home, (core) => runPreview(core, io, folder, v), { configBanner: false })
}
