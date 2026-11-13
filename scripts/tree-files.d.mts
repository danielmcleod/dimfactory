// Declarations for scripts/tree-files.mjs (the files of a working tree or a git tree, for the file checks).

export interface CheckedFile {
  path: string
  /** undefined for a binary file. */
  text: string | undefined
}
/** Text, or undefined for a binary file (a NUL byte in its first 8 KB). */
export function textOf(buf: Buffer): string | undefined
/** The files of the working tree at `root` (tracked, plus untracked ones not ignored), read from disk. */
export function workingTreeFiles(root: string): Generator<CheckedFile>
/** The files of a commit, branch or tree, read from the object store (submodules skipped). */
export function treeFiles(root: string, ref: string): Generator<CheckedFile>
