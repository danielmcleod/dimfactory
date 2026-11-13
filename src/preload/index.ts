// Sandboxed preload, bundled to CJS: exposes window.dimFactory
// (DimFactoryApi) and nothing else. Uses only electron's contextBridge / ipcRenderer and process.platform / argv
// (the initial theme arrives as `--dim-factory-theme=`).
import { contextBridge, ipcRenderer } from 'electron'
import { BRAND } from '../shared/brand.ts'
import { createDimFactoryApi } from './bridge.ts'

contextBridge.exposeInMainWorld(
  BRAND.preloadGlobal,
  createDimFactoryApi(ipcRenderer, { platform: process.platform, argv: process.argv }),
)
