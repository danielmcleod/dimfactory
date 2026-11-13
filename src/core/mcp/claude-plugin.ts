// The Claude Code plugin for Dim Factory's tools: a local plugin marketplace under DIM_FACTORY_HOME/claude-marketplace
// whose `dim-factory` plugin runs the `Dim Factory --mcp` stdio bridge (its `.mcp.json`) and carries a skill describing
// the tools (its `skills/` folder), the same skill the Codex plugin carries. Nothing is written or run until the user
// confirms in Settings: `claudePluginPlan` lists the files and commands, `installClaudePlugin` writes the files and runs
// `claude plugin marketplace add <dir>` and `claude plugin install dim-factory@dim-factory` (user scope, the CLI's
// default, so every Claude Code session on this computer sees it).
import { join } from 'node:path'
import type { ClaudePluginResult, McpBridgeCommand } from '../../shared/ipc.ts'
import { MCP_SERVER_NAME, PLUGIN_SKILL } from './instructions.ts'
import { installPlugin, pluginJson, pluginPlan } from './plugin-install.ts'
import type { PluginCliRunner, PluginFile } from './plugin-install.ts'
import { BRAND } from '../../shared/brand.ts'

export const CLAUDE_MARKETPLACE = BRAND.claudeMarketplace
export const CLAUDE_PLUGIN = BRAND.claudePlugin

/** Runs the Claude Code CLI with these arguments (null: Claude Code was not found). */
export type ClaudeRunner = PluginCliRunner

const DESCRIPTION =
  "Read Dim Factory's runs (plans, findings, diffs, logs) and ask it for new runs, which the user approves."

export function claudeMarketplaceDir(home: string): string {
  return join(home, 'claude-marketplace')
}

/** Every file the marketplace holds, with its content. */
export function claudePluginFiles(home: string, bridge: McpBridgeCommand): PluginFile[] {
  const root = claudeMarketplaceDir(home)
  const plugin = join(root, 'plugins', CLAUDE_PLUGIN)
  return [
    {
      path: join(root, '.claude-plugin', 'marketplace.json'),
      content: pluginJson({
        name: CLAUDE_MARKETPLACE,
        owner: { name: BRAND.displayName },
        metadata: { description: `${BRAND.displayName} on this computer` },
        plugins: [
          {
            name: CLAUDE_PLUGIN,
            source: `./plugins/${CLAUDE_PLUGIN}`,
            description: DESCRIPTION,
            category: 'development',
          },
        ],
      }),
    },
    {
      path: join(plugin, '.claude-plugin', 'plugin.json'),
      content: pluginJson({
        name: CLAUDE_PLUGIN,
        version: '0.1.0',
        description: DESCRIPTION,
        author: { name: BRAND.displayName },
        license: 'MIT',
        keywords: [BRAND.slug, 'runs', 'mcp'],
      }),
    },
    {
      path: join(plugin, '.mcp.json'),
      content: pluginJson({
        mcpServers: { [MCP_SERVER_NAME]: { command: bridge.command, args: bridge.args } },
      }),
    },
    { path: join(plugin, 'skills', CLAUDE_PLUGIN, 'SKILL.md'), content: PLUGIN_SKILL },
  ]
}

/** The commands an install runs, as the user reads them. */
export function claudePluginCommands(home: string): string[][] {
  return [
    ['plugin', 'marketplace', 'add', claudeMarketplaceDir(home)],
    ['plugin', 'install', `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`],
  ]
}

/** What an install would write and run; writes nothing. */
export function claudePluginPlan(home: string, bridge: McpBridgeCommand): ClaudePluginResult {
  return pluginPlan({
    dir: claudeMarketplaceDir(home),
    files: claudePluginFiles(home, bridge),
    commands: claudePluginCommands(home),
    bin: 'claude',
  })
}

/** Write the marketplace, then register it and install the plugin with the Claude Code CLI. */
export function installClaudePlugin(
  home: string,
  bridge: McpBridgeCommand,
  runClaude: ClaudeRunner,
): Promise<ClaudePluginResult> {
  return installPlugin({
    dir: claudeMarketplaceDir(home),
    files: claudePluginFiles(home, bridge),
    commands: claudePluginCommands(home),
    bin: 'claude',
    run: runClaude,
    notFound: 'Claude Code was not found. Install Claude Code, or run these commands in a terminal.',
  })
}
