// Outside agents in main: the bridge command (packaged and in development), the --mcp switch, and the editors'
// install links, built from the bridge command alone (mcp.addToEditor takes nothing else from the renderer).
import { describe, expect, it, vi } from 'vitest'
import { bridgeCommand, editorInstallUrl, isMcpBridgeLaunch } from '../../../src/main/mcp-links.ts'
import { createMainHandlers } from '../../../src/main/main-handlers.ts'
import type { MainHandlerDeps } from '../../../src/main/main-handlers.ts'
import { silentLogger } from '../../../src/core/log.ts'

const BRIDGE = { command: 'C:\\Program Files\\Dim Factory\\Dim Factory.exe', args: ['--mcp'] }

describe('the bridge command', () => {
  it('is the executable with --mcp, plus the app folder in development', () => {
    expect(
      bridgeCommand({ execPath: 'C:\\c\\Dim Factory.exe', packaged: true, appPath: 'C:\\c\\app.asar' }),
    ).toEqual({
      command: 'C:\\c\\Dim Factory.exe',
      args: ['--mcp'],
    })
    expect(bridgeCommand({ execPath: 'C:\\e\\electron.exe', packaged: false, appPath: 'C:\\repo' })).toEqual({
      command: 'C:\\e\\electron.exe',
      args: ['C:\\repo', '--mcp'],
    })
    expect(isMcpBridgeLaunch(['electron', '.', '--mcp'])).toBe(true)
    expect(isMcpBridgeLaunch(['electron', '.'])).toBe(false)
  })
})

describe('editor install links', () => {
  it('VS Code: vscode:mcp/install with the stdio server as JSON', () => {
    const url = editorInstallUrl('vscode', BRIDGE)
    expect(url.startsWith('vscode:mcp/install?')).toBe(true)
    expect(JSON.parse(decodeURIComponent(url.slice('vscode:mcp/install?'.length)))).toEqual({
      name: 'dim-factory',
      type: 'stdio',
      command: BRIDGE.command,
      args: ['--mcp'],
    })
  })

  it('Cursor: its deeplink with the config as base64 JSON', () => {
    const url = new URL(editorInstallUrl('cursor', BRIDGE))
    expect(url.protocol).toBe('cursor:')
    expect(url.host).toBe('anysphere.cursor-deeplink')
    expect(url.pathname).toBe('/mcp/install')
    expect(url.searchParams.get('name')).toBe('dim-factory')
    const config = JSON.parse(
      Buffer.from(url.searchParams.get('config') ?? '', 'base64').toString('utf8'),
    ) as unknown
    expect(config).toEqual({ command: BRIDGE.command, args: ['--mcp'] })
  })

  it('mcp.addToEditor opens the link main built, or records it under E2E', async () => {
    const openExternal = vi.fn(() => Promise.resolve())
    const base = {
      core: { paths: {} as never, log: silentLogger },
      openExternal,
    } as unknown as MainHandlerDeps
    const h = createMainHandlers({ ...base, mcp: { bridge: BRIDGE } })
    await h['mcp.addToEditor']?.({ editor: 'vscode' })
    expect(openExternal).toHaveBeenCalledWith(editorInstallUrl('vscode', BRIDGE))
    const record = vi.fn()
    const e2e = createMainHandlers({ ...base, mcp: { bridge: BRIDGE, recordEditorLink: record } })
    await e2e['mcp.addToEditor']?.({ editor: 'cursor' })
    expect(record).toHaveBeenCalledWith(editorInstallUrl('cursor', BRIDGE))
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(createMainHandlers(base)['mcp.addToEditor']).toBeUndefined()
  })
})
