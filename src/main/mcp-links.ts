// Outside agents: the `Dim Factory --mcp` bridge command and the editors' MCP install links. The links are built here,
// in main, from the bridge command only (never from text the renderer sends), so a page can never make Dim Factory open
// an install link for some other command.
import type { McpBridgeCommand } from '@shared/ipc.ts'
import { BRAND } from '@shared/brand.ts'

export const MCP_SERVER_NAME = BRAND.mcpServerName

/** This executable with --mcp; in development, Electron plus the app folder. */
export function bridgeCommand(o: { execPath: string; packaged: boolean; appPath: string }): McpBridgeCommand {
  return { command: o.execPath, args: o.packaged ? ['--mcp'] : [o.appPath, '--mcp'] }
}

/** True when this process was started as the stdio bridge. */
export function isMcpBridgeLaunch(argv: readonly string[]): boolean {
  return argv.includes('--mcp')
}

/** VS Code's `vscode:mcp/install?<json>` and Cursor's deeplink for the bridge. */
export function editorInstallUrl(editor: 'vscode' | 'cursor', bridge: McpBridgeCommand): string {
  const config = { command: bridge.command, args: [...bridge.args] }
  if (editor === 'vscode') {
    return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_SERVER_NAME, type: 'stdio', ...config }))}`
  }
  const b64 = Buffer.from(JSON.stringify(config)).toString('base64')
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${encodeURIComponent(b64)}`
}
