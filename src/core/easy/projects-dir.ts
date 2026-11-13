// Where Easy puts new projects by default: "Dim Factory Projects" in the user's Documents folder, unless OneDrive
// syncs that folder (OneDrive's folder backup moves Documents into OneDrive, and syncing an app project's thousands
// of small files in node_modules fights the install, the build and the preview); then it is the same name in the
// user's own folder (%USERPROFILE%), and Easy says why. A projects folder the user set in Easy settings always wins,
// and projects already made are never moved. Pure.
import { isAbsolute, join, relative, win32 } from 'node:path'
import { BRAND } from '../../shared/brand.ts'

/** The default projects folder's name. */
export const PROJECTS_FOLDER_NAME = `${BRAND.displayName} Projects`

/** OneDrive's own variables: the folder it syncs (personal, work or school). */
const ONEDRIVE_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const

/** A path segment OneDrive names its folder with ("OneDrive", "OneDrive - Contoso"). */
const ONEDRIVE_SEGMENT = /^OneDrive(?:\s*-\s*.+)?$/i

function within(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const fold = (p: string): string => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p)
  const win = platform === 'win32'
  const rel = win ? win32.relative(fold(parent), fold(child)) : relative(fold(parent), fold(child))
  return rel === '' || (!rel.startsWith('..') && !(win ? win32.isAbsolute(rel) : isAbsolute(rel)))
}

/** Whether OneDrive syncs the Documents folder: it is inside a folder OneDrive's variables name, or one named for it. */
export function oneDriveSynced(
  documentsDir: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  for (const v of ONEDRIVE_VARS) {
    const root = env[v]
    if (root !== undefined && root.trim() !== '' && within(documentsDir, root.trim(), platform)) return true
  }
  return documentsDir.split(/[\\/]+/).some((s) => ONEDRIVE_SEGMENT.test(s))
}

/** The default projects folder, and why it is not in Documents (absent: it is). */
export function defaultProjectsDir(o: {
  documentsDir: string
  homeDir: string
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}): { dir: string; reason?: 'onedrive' } {
  const platform = o.platform ?? process.platform
  const join_ = (a: string, b: string): string => (platform === 'win32' ? win32.join(a, b) : join(a, b))
  if (oneDriveSynced(o.documentsDir, o.env, platform))
    return { dir: join_(o.homeDir, PROJECTS_FOLDER_NAME), reason: 'onedrive' }
  return { dir: join_(o.documentsDir, PROJECTS_FOLDER_NAME) }
}
