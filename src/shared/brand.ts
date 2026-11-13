// The product's names and identifiers, in one place. Code reads them from here; the build scripts import this file
// too, and scripts/brand-sync.mjs writes the same values into the files that cannot import it (electron-builder.yml,
// package.json, LICENSE, the NSIS include, the Linux package scripts and the AppArmor profile) and checks that they
// agree.
// No imports: Node runs this file directly (type stripping) for the scripts.

export const BRAND = Object.freeze({
  /** The name people see: window title, installer, notifications, docs. */
  displayName: 'Dim Factory',
  /** Package name, Linux executable, artifacts, deb package, .desktop entry, temp-folder prefixes. */
  slug: 'dim-factory',
  /** The Windows AUMID and the macOS bundle id (electron-builder appId). */
  appId: 'com.dimfactory.desktop',
  /** The Windows toast activator GUID, tied to appId (build/installer.nsh registers the same one). */
  toastActivatorClsid: '{5623D05F-66EA-4E4C-993F-A156F0425595}',
  /** Prefix of every environment variable the app reads for itself. */
  envPrefix: 'DIM_FACTORY_',
  /** The home folder's name under the user's home directory. */
  homeDirName: '.dimfactory',
  /** A project's folder (its config, prompts and packs). */
  projectDirName: '.dimfactory',
  /** The config file's name, user and project. */
  configFileName: 'dimfactory.json',
  /** The project memory file at a project's root (conventions, decisions, run and deploy notes fed to every pass). */
  memoryFileName: 'DIM_FACTORY.md',
  /** The config JSON schema's file name. */
  schemaFileName: 'dimfactory.schema.json',
  /** The command-line tool. */
  cliName: 'dimf',
  /** Other names the command-line tool answers to. */
  cliAliases: Object.freeze(['dim-factory'] as const),
  /** Prefix of a run's own branch. */
  branchPrefix: 'dim/',
  /** The shadow repository's own ref namespace. */
  refNamespace: 'refs/dimfactory/',
  /** Where the shadow repository keeps each run's snapshot ref. */
  runRefPrefix: 'refs/dimfactory/runs/',
  /** IPC channel prefix (`<prefix>:cmd`, `<prefix>:evt`). */
  ipcPrefix: 'dimf',
  /** The preload API's name on `window`. */
  preloadGlobal: 'dimFactory',
  /** The built renderer's origin host (`app://<host>/`). */
  rendererHost: 'dim-factory',
  /** Prefix of the renderer's browser storage keys. */
  storagePrefix: 'dimf.',
  /** The MCP server name outside agents, the bridge and the agent plugins use (tool names do not carry it). */
  mcpServerName: 'dim-factory',
  /** The client name sent to vendor CLIs (`clientInfo.name`, which they put into their user agents). */
  clientName: 'dim-factory',
  /** The Codex plugin and its marketplace (`<plugin>@<marketplace>`). */
  codexPlugin: 'dim-factory',
  codexMarketplace: 'dim-factory',
  /** The Claude Code plugin and its marketplace (`<plugin>@<marketplace>`). */
  claudePlugin: 'dim-factory',
  claudeMarketplace: 'dim-factory',
  /** Copyright holder and package author: never a person. LICENSE and the installers' copyright carry it. */
  authors: 'The Dim Factory authors',
  /** The year in the copyright line (LICENSE, electron-builder `copyright`). */
  copyrightYear: '2026',
  /** The licence, as an SPDX id (package.json `license`; LICENSE holds its text). */
  license: 'MIT',
})

/** LICENSE's copyright line. */
export const LICENSE_COPYRIGHT = `Copyright (c) ${BRAND.copyrightYear} ${BRAND.authors}`

/** An environment variable of the app's own, by its suffix (`envName('HOME')`). */
export function envName(suffix: string): string {
  return `${BRAND.envPrefix}${suffix}`
}

/** The home folder override (`<prefix>HOME`). */
export const HOME_ENV = envName('HOME')

/**
 * The project folder's name before the product was renamed. Nothing reads or migrates it: a project that still has one
 * gets a notice offering to rename it (preflight). The one place the former name may appear in code.
 */
export const FORMER_PROJECT_DIRNAME = '.conductor'
