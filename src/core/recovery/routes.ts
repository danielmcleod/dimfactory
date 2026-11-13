// `settings_link` → renderer route (hash router with deep links).
// Actions name `settings/<section>` (ids of src/renderer/src/pages/settings/sections.ts, which also maps the older
// `settings/storage` and `settings/passes` names) or `composer`, plus a JSON pointer that becomes `?field=`. A link
// about a project's file (a config error in `<folder>/.dimfactory/dimfactory.json`) also names the folder (`&folder=`),
// so Settings → Config file opens that project's file.
import { DimFactoryError } from '../errors.ts'

const SEGMENT = /^[a-z][a-z0-9-]*$/

/** The pointer of a link to Settings → Config file's Restore last good (that section focuses the button for it). */
export const LAST_GOOD_POINTER = '/backups/last-good'

/**
 * `#/settings/<section>[/<sub>…][?field=<pointer>][&folder=<folder>]`, or `#/[?field=<pointer>]` for the composer.
 * VALIDATION for a route Dim Factory does not link to (an action is core-built, so this guards against a malformed one).
 */
export function settingsHref(route: string, pointer: string, folder?: string): string {
  const segs = route.split('/').filter((s) => s !== '')
  if (segs.length === 0 || !segs.every((s) => SEGMENT.test(s))) {
    throw new DimFactoryError('VALIDATION', `"${route}" is not a page Dim Factory can open.`)
  }
  if (pointer !== '' && !pointer.startsWith('/')) {
    throw new DimFactoryError('VALIDATION', `"${pointer}" is not a settings field.`)
  }
  const [head, ...rest] = segs
  const composer = head === 'composer' || head === 'dashboard'
  if ((composer && rest.length > 0) || (!composer && head !== 'settings')) {
    throw new DimFactoryError('VALIDATION', `"${route}" is not a page Dim Factory can open.`)
  }
  const params = [
    ...(pointer === '' ? [] : [`field=${encodeURIComponent(pointer)}`]),
    ...(folder === undefined || folder === '' || composer ? [] : [`folder=${encodeURIComponent(folder)}`]),
  ]
  const query = params.length === 0 ? '' : `?${params.join('&')}`
  return composer ? `#/${query}` : `#/${segs.join('/')}${query}`
}

/** The project folder a settings_link's `suggested` names (a project config file's), if any. */
export function suggestedFolder(suggested: unknown): string | undefined {
  if (typeof suggested !== 'object' || suggested === null) return undefined
  const s = suggested as Record<string, unknown>
  return s['scope'] === 'project' && typeof s['folder'] === 'string' && s['folder'] !== ''
    ? s['folder']
    : undefined
}
