// File drops (boot hardening): Chromium navigates a page to a file dropped on it. Main blocks that
// navigation, but the app takes no drops at all, so the page refuses them first (no-drop cursor, nothing happens).
// A future drop target handles its own events and stops them before they reach the document.

function refuse(e: Event): void {
  e.preventDefault()
  const dt = (e as Partial<DragEvent>).dataTransfer
  if (dt !== null && dt !== undefined) dt.dropEffect = 'none'
}

/** Refuse drag-and-drop on the whole document; returns the removal function. */
export function installDropGuard(doc: Document = document): () => void {
  doc.addEventListener('dragover', refuse)
  doc.addEventListener('drop', refuse)
  return () => {
    doc.removeEventListener('dragover', refuse)
    doc.removeEventListener('drop', refuse)
  }
}
