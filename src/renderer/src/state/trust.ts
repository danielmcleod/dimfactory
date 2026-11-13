// Folder trust state the renderer shares (trust.json `vendorFolder`, the readiness check `trust`): the
// trust epoch and the folder the composer checks. Core decides trust; this only says when to ask it again.
import { create } from 'zustand'

/*
 * Two small facts outside the main store: the trust epoch, bumped by every vendorFolder grant or revoke made in this
 * window, so whatever read core's answer reads it again (the composer's live checks, the setup card's chip, Settings →
 * Vendors); and the folder the composer checks now, so the setup card's trust chip names the same folder the
 * composer's checks are about.
 */

interface TrustUi {
  /** Bumped by every vendorFolder grant or revoke made in this window. */
  epoch: number
  /** The absolute folder the composer checks now; null while it has none. */
  composerFolder: string | null
}

const INITIAL: TrustUi = { epoch: 0, composerFolder: null }

const useTrustUi = create<TrustUi>()(() => INITIAL)

/** Changes after every vendorFolder grant or revoke made in this window. */
export function useTrustEpoch(): number {
  return useTrustUi((s) => s.epoch)
}

/** The epoch now, outside React. */
export function trustEpochNow(): number {
  return useTrustUi.getState().epoch
}

/** A grant or revoke was written: whatever shows core's trust answers asks again. */
export function bumpTrustEpoch(): void {
  useTrustUi.setState((s) => ({ epoch: s.epoch + 1 }))
}

/** The absolute folder the composer checks now (null: none chosen yet). */
export function useComposerFolder(): string | null {
  return useTrustUi((s) => s.composerFolder)
}

/** The composer's folder for this read, outside React. */
export function composerFolderNow(): string | null {
  return useTrustUi.getState().composerFolder
}

/** The composer publishes the folder it checks (its committed absolute folder, or null). */
export function setComposerFolder(folder: string | null): void {
  if (useTrustUi.getState().composerFolder === folder) return
  useTrustUi.setState({ composerFolder: folder })
}

/** Tests: forget the epoch and the composer's folder. */
export function resetTrustStateForTests(): void {
  useTrustUi.setState(INITIAL, true)
}
