// The preview session a Done screen button uses (Open it, Play-test it again): the rendered document (a document kind)
// or the page, started when it is not running yet.
import { invoke } from '../../ipc/client.ts'
import { upsertPreviewSessions } from '../../state/previews.ts'
import { openTargetOf } from './model.ts'
import { OPEN_NOTHING, OPEN_TRUST_FIRST } from './text.ts'

/**
 * The preview session Open it uses: the rendered document (a document kind) or the page, started when it is not
 * running yet. A string: why there is none (UI copy).
 */
export async function openSession(
  runId: string,
  document: boolean,
): Promise<{ sessionId: string; openIn: 'app' | 'browser'; kind: string } | string> {
  const d = await invoke('preview.detect', { runId })
  if (!d.ok) return d.error.message
  upsertPreviewSessions(d.value.sessions)
  const t = openTargetOf(d.value, document)
  if (t.kind === 'none') return OPEN_NOTHING
  if (t.kind === 'command') return OPEN_TRUST_FIRST
  let session = d.value.sessions.find((s) => s.commandId === t.commandId && s.status === 'running')
  if (session === undefined) {
    const s = await invoke('preview.start', { runId, commandId: t.commandId })
    if (!s.ok) return s.error.message
    upsertPreviewSessions([s.value])
    session = s.value
  }
  return { sessionId: session.id, openIn: d.value.openIn === 'browser' ? 'browser' : 'app', kind: t.kind }
}
