// window.dimFactory, as the preload exposes it; included by the web and E2E tsconfigs.
import type { DimFactoryApi } from '../shared/ipc.ts'

declare global {
  interface Window {
    dimFactory: DimFactoryApi
  }
}

export {}
