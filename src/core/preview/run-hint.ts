// `{{run}}` in the Implement and Fix prompts (Run & Preview): when Dim Factory can find no way to run the folder and it
// has no RUN.md, the pass is asked to write one, so the Run it panel has something to show. Token-free (detect.ts);
// never throws (a folder that cannot be read asks for nothing).
import { PREVIEW_RUN_MD_MAX } from '../../shared/preview.ts'
import { detectPreviewCommands, readRunMd } from './detect.ts'

export const RUN_MD_REQUEST = [
  'Dim Factory found no way to run this project (no dev, start or preview script, no entry point, compose file or',
  'index.html). If what you build can be run, add a RUN.md at the project root that says how: the prerequisites, the',
  'command that starts it, the environment variables it reads (names only, never their values) and an example of using',
  'it.',
].join(' ')

/** The `{{run}}` value for a pass working in `folder`: the RUN.md request, or null when there is nothing to ask. */
export async function runInstructionsHint(folder: string): Promise<string | null> {
  try {
    const [commands, runMd] = await Promise.all([
      detectPreviewCommands({ folder }),
      readRunMd(folder, PREVIEW_RUN_MD_MAX),
    ])
    return commands.length === 0 && runMd === null ? RUN_MD_REQUEST : null
  } catch {
    return null
  }
}
