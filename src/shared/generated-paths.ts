// Folders that hold what a dependency install or a build writes, never what a person or a pass edits by hand. The
// plan-end guard leaves them out: Dim Factory's own install (or a package manager's link step, a dev server's cache)
// can write there while Plan runs, and that is no sign that Plan, a read-only pass, changed the project.

/** Dependency, cache and build output folders, matched as any segment of a repo-relative path. */
export const GENERATED_DIRS: readonly string[] = Object.freeze([
  'node_modules',
  '.pnpm-store',
  '.yarn',
  'bower_components',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'dist',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.cache',
  'coverage',
  'target',
])

const DIRS = new Set(GENERATED_DIRS)

/** Whether a repo-relative path (forward or back slashes) is inside a dependency or build output folder. */
export function isGeneratedPath(path: string): boolean {
  const segments = path.split(/[\\/]/)
  // The last segment is the file itself: a file named `dist` is not a folder of output.
  return segments.slice(0, -1).some((s) => DIRS.has(s))
}
