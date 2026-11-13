// The Codex plugin for Dim Factory's tools: a local plugin marketplace under DIM_FACTORY_HOME/codex-marketplace (the Codex
// CLI, desktop app and IDE extension share it once registered) whose `dim-factory` plugin runs the `Dim Factory --mcp`
// stdio bridge and carries a skill describing the tools. Nothing is written or run until the user confirms in
// Settings: `codexPluginPlan` lists the files and commands, `installCodexPlugin` writes the files and runs
// `codex plugin marketplace add <dir>` and `codex plugin add dim-factory@dim-factory`.
import { join } from 'node:path'
import type { CodexPluginResult, McpBridgeCommand } from '../../shared/ipc.ts'
import { MCP_SERVER_NAME, PLUGIN_SKILL } from './instructions.ts'
import { installPlugin, pluginJson, pluginPlan } from './plugin-install.ts'
import type { PluginCliRunner, PluginFile } from './plugin-install.ts'
import { BRAND } from '../../shared/brand.ts'

export const CODEX_MARKETPLACE = BRAND.codexMarketplace
export const CODEX_PLUGIN = BRAND.codexPlugin

/** Runs the Codex CLI with these arguments (null: Codex was not found). */
export type CodexRunner = PluginCliRunner

export function codexMarketplaceDir(home: string): string {
  return join(home, 'codex-marketplace')
}

/** Every file the marketplace holds, with its content. */
export function codexPluginFiles(home: string, bridge: McpBridgeCommand): PluginFile[] {
  const root = codexMarketplaceDir(home)
  const plugin = join(root, 'plugins', CODEX_PLUGIN)
  const json = pluginJson
  return [
    {
      path: join(root, '.agents', 'plugins', 'marketplace.json'),
      content: json({
        name: CODEX_MARKETPLACE,
        interface: { displayName: 'Dim Factory (this computer)' },
        plugins: [
          {
            name: CODEX_PLUGIN,
            source: { source: 'local', path: `./plugins/${CODEX_PLUGIN}` },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Developer Tools',
          },
        ],
      }),
    },
    {
      path: join(plugin, '.codex-plugin', 'plugin.json'),
      content: json({
        name: CODEX_PLUGIN,
        version: '0.1.0',
        description:
          "Read Dim Factory's runs (plans, findings, diffs, logs) and ask it for new runs, which the user approves.",
        author: { name: BRAND.displayName },
        license: 'MIT',
        keywords: [BRAND.slug, 'runs', 'mcp'],
        skills: './skills/',
        mcpServers: './.mcp.json',
        interface: {
          displayName: BRAND.displayName,
          shortDescription: 'Read Dim Factory runs and ask for new ones',
          longDescription:
            'Use Dim Factory to see how your coding runs went (status, plans, findings, diffs and logs) and to ask for a new run, which waits in Dim Factory until you approve it.',
          developerName: BRAND.displayName,
          category: 'Developer Tools',
          capabilities: ['Read'],
          defaultPrompt: ['What did my last Dim Factory run change?'],
        },
      }),
    },
    {
      path: join(plugin, '.mcp.json'),
      content: json({ mcpServers: { [MCP_SERVER_NAME]: { command: bridge.command, args: bridge.args } } }),
    },
    { path: join(plugin, 'skills', CODEX_PLUGIN, 'SKILL.md'), content: PLUGIN_SKILL },
  ]
}

/** The commands an install runs, as the user reads them. */
export function codexPluginCommands(home: string): string[][] {
  return [
    ['plugin', 'marketplace', 'add', codexMarketplaceDir(home)],
    ['plugin', 'add', `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`],
  ]
}

/** What an install would write and run; writes nothing. */
export function codexPluginPlan(home: string, bridge: McpBridgeCommand): CodexPluginResult {
  return pluginPlan({
    dir: codexMarketplaceDir(home),
    files: codexPluginFiles(home, bridge),
    commands: codexPluginCommands(home),
    bin: 'codex',
  })
}

/** Write the marketplace, then register it and install the plugin with the Codex CLI. */
export function installCodexPlugin(
  home: string,
  bridge: McpBridgeCommand,
  runCodex: CodexRunner,
): Promise<CodexPluginResult> {
  return installPlugin({
    dir: codexMarketplaceDir(home),
    files: codexPluginFiles(home, bridge),
    commands: codexPluginCommands(home),
    bin: 'codex',
    run: runCodex,
    notFound: 'Codex was not found. Install the Codex CLI, or run these commands in a terminal.',
  })
}
