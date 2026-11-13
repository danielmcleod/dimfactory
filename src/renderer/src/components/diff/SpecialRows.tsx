// The Diff tab's special rows (binary, with an image preview ≤ 2 MB via `diff.blob`; EOL-only; gitlink;
// edited-after-run; plus a mode change and a rename with no line changed). Each is a line of text
// in the file's body where a diff would go, from core's FileChange; a binary image shows its two sides beside each
// other from core's blobs (`data:` URLs, which the CSP allows for images), anything else its size.
// Nothing moves as a blob arrives: a file whose name says it is an image keeps the preview's room from the start.
import type { DiffBlob, DiffSegment, FileChange } from '@shared/ipc.ts'
import { cn } from '../../lib/cn.ts'
import { useBlob } from './patches.ts'
import type { BlobSide, Loaded } from './patches.ts'
import { binaryText } from './text.ts'

// The formats core sends as images (an SVG is text: core diffs it as lines).
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i

/** Whether the file's name says it is an image (only to keep the preview's room before core answers). */
export function looksLikeImage(path: string): boolean {
  return IMAGE_EXT.test(path)
}

function imageOf(b: Loaded<DiffBlob> | null): { src: string; bytes: number } | null {
  if (b === null || b.kind !== 'ready') return null
  const { mime, base64, bytes } = b.value
  if (mime === null || !mime.startsWith('image/') || base64 === '') return null
  return { src: `data:${mime};base64,${base64}`, bytes }
}

function bytesOf(b: Loaded<DiffBlob> | null): number | null {
  return b !== null && b.kind === 'ready' ? b.value.bytes : null
}

export function MessageRow({
  children,
  testId,
  tone = 'muted',
}: {
  children: React.ReactNode
  testId: string
  tone?: 'muted' | 'error'
}): React.JSX.Element {
  return (
    <p
      data-testid={testId}
      className={cn('px-3 py-2 text-sm', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {children}
    </p>
  )
}

const SIDE_LABEL: Readonly<Record<BlobSide, string>> = { old: 'Before', new: 'After' }

function Side({
  side,
  f,
  blob,
  present,
}: {
  side: BlobSide
  f: FileChange
  blob: Loaded<DiffBlob> | null
  present: boolean
}): React.JSX.Element {
  const img = imageOf(blob)
  const name = side === 'old' ? (f.oldPath ?? f.path) : f.path
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-1" data-side={side}>
      <figcaption className="text-xs text-muted-foreground">{SIDE_LABEL[side]}</figcaption>
      <div className="flex h-48 items-center justify-center overflow-clip rounded-md border bg-muted/40 p-2">
        {img !== null ? (
          <img
            src={img.src}
            alt={`${name}, ${SIDE_LABEL[side].toLowerCase()}`}
            data-testid={`diff-image-${side}`}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {!present
              ? 'None'
              : blob === null || blob.kind === 'loading'
                ? 'Loading…'
                : binaryText(bytesOf(blob))}
          </span>
        )}
      </div>
    </figure>
  )
}

/** A binary file: both sides as images when core sends them, else "Binary file, N KB". */
export function BinaryBody({
  runId,
  seg,
  f,
  enabled,
}: {
  runId: string
  seg: DiffSegment
  f: FileChange
  /** Ask core for the blobs (the section is near the view and open). */
  enabled: boolean
}): React.JSX.Element {
  const hasOld = f.status !== 'A'
  const hasNew = f.status !== 'D'
  const oldBlob = useBlob(runId, seg, f, 'old', enabled && hasOld)
  const newBlob = useBlob(runId, seg, f, 'new', enabled && hasNew)
  const image = imageOf(oldBlob) !== null || imageOf(newBlob) !== null
  if (image || looksLikeImage(f.path)) {
    return (
      <div data-testid="diff-binary" data-image="" className="flex gap-3 px-3 py-2">
        <Side side="old" f={f} blob={oldBlob} present={hasOld} />
        <Side side="new" f={f} blob={newBlob} present={hasNew} />
      </div>
    )
  }
  // The size is the side that is there now (the old one for a deleted file); without core's answer, no size.
  return <MessageRow testId="diff-binary">{binaryText(bytesOf(hasNew ? newBlob : oldBlob))}</MessageRow>
}
