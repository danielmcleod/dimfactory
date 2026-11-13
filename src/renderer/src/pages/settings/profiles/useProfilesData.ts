// What Settings → Profiles reads (config layers; IPC config.read / config.resolve): your dimfactory.json and,
// with a project chosen, that project's (config.read, for the profiles each file defines and its own `profile`), and
// config.resolve without a folder (your default as core resolves it, and the local presets the vendor picker lists).
// Read once the section has been open for LOAD_DELAY_MS, again on every config change and after each write.
import { useCallback, useEffect, useState } from 'react'
import type { ConfigReadResult, ResolvedWithProvenance } from '@shared/ipc.ts'
import { invoke } from '../../../ipc/client.ts'
import { useConfigEpoch } from '../../../state/selectors.ts'
import { LOAD_DELAY_MS } from '../general/ProjectFolder.tsx'

export interface ProfilesData {
  /** null until read. */
  user: ConfigReadResult | null
  /** null without a project, and until read. */
  project: ConfigReadResult | null
  resolved: ResolvedWithProvenance | null
  error: string | null
  projectError: string | null
  /** Your file (and the project's, when one is chosen) have been read. */
  loaded: boolean
}

const EMPTY: ProfilesData = {
  user: null,
  project: null,
  resolved: null,
  error: null,
  projectError: null,
  loaded: false,
}

export function useProfilesData(folder: string | null): ProfilesData & { reload: () => void } {
  const epoch = useConfigEpoch()
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ folder: string | null; data: ProfilesData }>({ folder, data: EMPTY })
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void Promise.all([
        invoke('config.read', { scope: 'user' }),
        invoke('config.resolve', {}),
        folder !== null ? invoke('config.read', { scope: 'project', folder }) : Promise.resolve(null),
      ]).then(([user, resolved, project]) => {
        if (!alive) return
        setState({
          folder,
          data: {
            user: user.ok ? user.value : null,
            resolved: resolved.ok ? resolved.value : null,
            project: project !== null && project.ok ? project.value : null,
            error: !user.ok ? user.error.message : null,
            projectError: project !== null && !project.ok ? project.error.message : null,
            loaded: true,
          },
        })
      })
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [folder, epoch, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  // Data read for another folder is not this folder's: until the new read answers, the project part is unknown.
  const data =
    state.folder === folder ? state.data : { ...state.data, project: null, projectError: null, loaded: false }
  return { ...data, reload }
}
