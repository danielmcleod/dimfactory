// The folder facts adaptive depth reads (no model, no network): whether the folder exists and how many files of its
// own it holds, counted up to a cap. Dependency and build output folders, the git folder and Dim Factory's own
// folder are left out, and so are the files every new repository starts with (a README, a licence, .gitignore), so a
// folder with nothing but those reads as a new project.
import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BRAND } from '../../shared/brand.ts'
import { GENERATED_DIRS } from '../../shared/generated-paths.ts'
import { FOLDER_COUNT_CAP } from './classify.ts'
import type { FolderSize } from './classify.ts'

const SKIP_DIRS: ReadonlySet<string> = new Set([
  ...GENERATED_DIRS,
  '.git',
  '.hg',
  '.svn',
  BRAND.projectDirName,
])

/** Files a new repository starts with: they do not make a folder an existing project. */
const STARTER_FILE =
  /^(?:readme|licen[cs]e|copying|changelog)(?:\.[\w.-]+)?$|^\.(?:gitignore|gitattributes|editorconfig)$|^\.env(?:\.[\w.-]+)?$|^(?:\.ds_store|thumbs\.db|desktop\.ini)$/i

/** Files a project works on rather than is made of: a folder of only these has data, not a project. */
const DATA_FILE = /\.(?:csv|tsv|xlsx?|ods|parquet|pdf|docx?|pptx?|txt|md|jpe?g|png|gif|webp|mp3|mp4)$/i

/** How many files of its own the folder holds (at most `cap`); `exists: false` when it is not a folder. */
export async function folderSize(folder: string, cap: number = FOLDER_COUNT_CAP): Promise<FolderSize> {
  try {
    if (!(await stat(folder)).isDirectory()) return { exists: false, files: 0 }
  } catch {
    return { exists: false, files: 0 }
  }
  let files = 0
  let data = 0
  const queue: string[] = [folder]
  while (queue.length > 0 && files < cap) {
    const dir = queue.shift() as string
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      continue
    }
    try {
      for await (const e of handle) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) queue.push(join(dir, e.name))
        } else if (e.isFile() && !(dir === folder && STARTER_FILE.test(e.name))) {
          files += 1
          if (DATA_FILE.test(e.name)) data += 1
          if (files >= cap) break
        }
      }
    } catch {
      // A folder that cannot be read further counts what was read.
    }
  }
  return { exists: true, files, ...(files > 0 && data === files ? { dataOnly: true } : {}) }
}
