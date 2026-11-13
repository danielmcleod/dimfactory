// `vendors.setPath` validation (Settings → Vendors: the path's Change, Auto-detect and candidates;
// `vendors.<id>.path`): the picked file must be an absolute path to an existing file that the resolver accepts as
// that vendor (the same examination and `--version` identification a configured path gets at launch). Only that one
// candidate is examined: nothing else on PATH or in well-known places is searched or spawned.
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CliSpec, ResolveCliOptions, ResolveResult } from '../proc/resolve-cli.ts'
import { resolveCli } from '../proc/resolve-cli.ts'

export type VendorPathCheck = { ok: true; path: string; version: string } | { ok: false; reason: string }

export type ResolveFn = (spec: CliSpec, opts: ResolveCliOptions) => Promise<ResolveResult>

export interface ValidateCliPathOptions extends Omit<ResolveCliOptions, 'configuredPath' | 'candidates'> {
  /** Test seam (default resolve-cli `resolveCli`). */
  resolve?: ResolveFn
}

/** Validate `path` as `spec.vendor`'s CLI (configured candidate only). Never throws for a bad path. */
export async function validateCliPath(
  spec: CliSpec,
  path: string,
  o: ValidateCliPathOptions = {},
): Promise<VendorPathCheck> {
  const p = path.trim()
  if (p === '' || !isAbsolute(p)) return { ok: false, reason: `${path} is not an absolute path.` }
  const st = await stat(p).catch(() => null)
  if (st === null) return { ok: false, reason: `${p} does not exist.` }
  if (!st.isFile()) return { ok: false, reason: `${p} is not a file.` }
  const { resolve = resolveCli, ...rest } = o
  const r = await resolve(spec, { ...rest, configuredPath: p, candidates: 'configured' })
  if (r.ok && r.cli.source === 'config') return { ok: true, path: r.cli.path, version: r.cli.version }
  const why = r.rejected.find((x) => x.source === 'config')
  return { ok: false, reason: why?.detail ?? `${p} is not the ${spec.vendor} CLI.` }
}
