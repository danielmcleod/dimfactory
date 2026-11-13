#!/usr/bin/env node
// Writes the product's names from src/shared/brand.ts into the files that cannot import it: package.json, LICENSE's
// copyright line, the electron-builder config, the NSIS include (the toast activator CLSID), the deb's install scripts
// and its AppArmor profile. `--check` only compares (exit 1 on any difference); a unit test runs it, so the files never drift.
//
//   node scripts/brand-sync.mjs [--check]
//
// Exit: 0 in sync (or written) · 1 out of sync (--check) · 2 usage error or a file whose brand line is missing
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BRAND, LICENSE_COPYRIGHT } from '../src/shared/brand.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Linux: the deb installs to /opt/<productName>/<executable>. */
const INSTALL_DIR = `/opt/${BRAND.displayName}`

/** Line rules per file: each `re` must match exactly one line, which becomes `line`. */
export const LINE_RULES = Object.freeze({
  LICENSE: [{ re: /^Copyright \(c\) .*$/m, line: LICENSE_COPYRIGHT }],
  'electron-builder.yml': [
    { re: /^appId: .*$/m, line: `appId: ${BRAND.appId}` },
    { re: /^productName: .*$/m, line: `productName: ${BRAND.displayName}` },
    { re: /^copyright: .*$/m, line: `copyright: Copyright © ${BRAND.copyrightYear} ${BRAND.authors}` },
    { re: /^ {2}executableName: .*$/m, line: `  executableName: ${BRAND.slug}` },
    {
      re: /^ {2}maintainer: .*$/m,
      line: `  maintainer: ${BRAND.displayName} maintainers <maintainers@${BRAND.slug.replace(/-/g, '')}.invalid>`,
    },
    { re: /^ {6}StartupWMClass: .*$/m, line: `      StartupWMClass: ${BRAND.displayName}` },
  ],
  'build/installer.nsh': [
    {
      re: /^!define \w+_TOAST_CLSID ".*"$/m,
      line: `!define ${BRAND.envPrefix}TOAST_CLSID "${BRAND.toastActivatorClsid}"`,
    },
  ],
  'build/linux/after-install.sh': [
    { re: /^INSTALL_DIR=.*$/m, line: `INSTALL_DIR='${INSTALL_DIR}'` },
    { re: /^EXECUTABLE=.*$/m, line: `EXECUTABLE='${BRAND.slug}'` },
  ],
  'build/linux/after-remove.sh': [
    { re: /^INSTALL_DIR=.*$/m, line: `INSTALL_DIR='${INSTALL_DIR}'` },
    { re: /^EXECUTABLE=.*$/m, line: `EXECUTABLE='${BRAND.slug}'` },
  ],
  'build/linux/apparmor-profile': [
    {
      re: /^profile \S+ .* flags=\(unconfined\) \{$/m,
      line: `profile ${BRAND.slug} "${INSTALL_DIR}/${BRAND.slug}" flags=(unconfined) {`,
    },
    { re: /^ {2}include if exists <local\/.*>$/m, line: `  include if exists <local/${BRAND.slug}>` },
  ],
})

/** package.json's brand fields. */
export function packageFields() {
  return {
    name: BRAND.slug,
    productName: BRAND.displayName,
    author: { name: BRAND.authors },
    license: BRAND.license,
    desktopName: `${BRAND.slug}.desktop`,
    bin: Object.fromEntries(
      [BRAND.cliName, ...BRAND.cliAliases].map((n) => [n, `src/cli/${BRAND.cliName}.ts`]),
    ),
  }
}

/** One file's text in sync: `{ text, changed }`, or throws when a rule's line is missing or ambiguous. */
export function syncText(file, text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (file === 'package.json') {
    const pkg = JSON.parse(text)
    const want = packageFields()
    const next = { ...pkg }
    for (const [k, v] of Object.entries(want)) next[k] = v
    // Keep the key order: a field package.json lacks goes after `main`.
    const ordered = {}
    for (const [k, v] of Object.entries(next)) if (k in pkg || !(k in want)) ordered[k] = v
    const out = {}
    for (const [k, v] of Object.entries(ordered)) {
      out[k] = v
      if (k === 'main') for (const [w, x] of Object.entries(want)) if (!(w in pkg)) out[w] = x
    }
    const synced = `${JSON.stringify(out, null, 2)}\n`.replace(/\n/g, eol)
    return { text: synced, changed: synced !== text }
  }
  let out = text
  for (const { re, line } of LINE_RULES[file] ?? []) {
    const global = new RegExp(re.source, 'gm')
    const n = [...out.matchAll(global)].length
    if (n !== 1) throw new Error(`${file}: expected one line matching ${re}, found ${n}`)
    out = out.replace(re, line)
  }
  return { text: out, changed: out !== text }
}

export const SYNCED_FILES = Object.freeze(['package.json', ...Object.keys(LINE_RULES)])

/** The command line. Returns the exit code. */
export function main(argv, { root = ROOT, log = console.log, err = console.error } = {}) {
  const check = argv.includes('--check')
  if (argv.some((a) => a !== '--check')) {
    err('usage: node scripts/brand-sync.mjs [--check]')
    return 2
  }
  const drift = []
  try {
    for (const file of SYNCED_FILES) {
      const path = join(root, file)
      const r = syncText(file, readFileSync(path, 'utf8'))
      if (!r.changed) continue
      drift.push(file)
      if (!check) writeFileSync(path, r.text)
    }
  } catch (e) {
    err(`brand-sync: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  if (drift.length === 0) {
    log(`In sync with src/shared/brand.ts: ${SYNCED_FILES.join(', ')}.`)
    return 0
  }
  for (const f of drift) log(`${check ? 'out of sync' : 'written'}: ${f}`)
  return check ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
