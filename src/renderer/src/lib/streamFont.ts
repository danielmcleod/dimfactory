// The stream font size from the user's dimfactory.json (`ui`, user-only: `streamFontSize` 12, 13 or 14; Settings →
// Appearance). Read once at start and again after every config change (the `config-changed` event
// bumps the store's config epoch), and applied as --stream-font-size (lib/theme.ts). An unreadable file leaves the
// size as it is.
import { invoke } from '../ipc/client.ts'
import { useStore } from '../state/store.ts'
import { setStreamFontSize, streamFontSizeOf } from './theme.ts'

/** Read `ui.streamFontSize` from the user file and apply it. */
export async function syncStreamFontSize(): Promise<void> {
  const r = await invoke('config.read', { scope: 'user' })
  if (r.ok) setStreamFontSize(streamFontSizeOf(r.value.value))
}

/** Apply the configured size now and after each config change; returns the unsubscribe. */
export function installStreamFontSize(): () => void {
  void syncStreamFontSize()
  return useStore.subscribe((s, prev) => {
    if (s.app.configEpoch !== prev.app.configEpoch) void syncStreamFontSize()
  })
}
