// Small static pictures for Easy's example cards, one per kind: drawn here as inline SVG (bundled with the app, no
// network, no image files), in the theme's colours so they follow light and dark. Decorative (aria-hidden): the card's
// title says what it is. Every picture has one fixed size, so a card never changes height while it loads.
import type { EasyKind } from '@shared/easy.ts'
import { cn } from '../../lib/cn.ts'

const PAGE = 'fill-background stroke-border'
const LINE = 'fill-muted-foreground/35'
const ACCENT = 'fill-primary/70'
const SOFT = 'fill-primary/20'

/** A row of text lines from (x, y), each `w` wide. */
function Lines({ x, y, widths }: { x: number; y: number; widths: readonly number[] }): React.JSX.Element {
  return (
    <>
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * 7} width={w} height={3} rx={1.5} className={LINE} />
      ))}
    </>
  )
}

function App(): React.JSX.Element {
  return (
    <>
      <rect x={58} y={4} width={44} height={64} rx={7} className={PAGE} strokeWidth={1.5} />
      <rect x={64} y={12} width={32} height={12} rx={2} className={SOFT} />
      <rect x={70} y={16} width={20} height={4} rx={1.5} className={ACCENT} />
      {[0, 1, 2].map((r) =>
        [0, 1, 2].map((c) => (
          <rect
            key={`${r}${c}`}
            x={64 + c * 11}
            y={29 + r * 11}
            width={9}
            height={8}
            rx={2}
            className={r === 2 && c === 2 ? ACCENT : LINE}
          />
        )),
      )}
    </>
  )
}

function Website(): React.JSX.Element {
  return (
    <>
      <rect x={20} y={6} width={120} height={60} rx={5} className={PAGE} strokeWidth={1.5} />
      <rect x={20} y={6} width={120} height={9} rx={5} className={SOFT} />
      <circle cx={27} cy={10.5} r={1.8} className={ACCENT} />
      <rect x={28} y={22} width={50} height={6} rx={2} className={ACCENT} />
      <Lines x={28} y={33} widths={[48, 40]} />
      <rect x={28} y={48} width={24} height={9} rx={3} className={ACCENT} />
      <rect x={88} y={22} width={44} height={35} rx={3} className={SOFT} />
      <path d="M92 53 L104 38 L113 47 L119 41 L129 53 Z" className={ACCENT} />
    </>
  )
}

function Document(): React.JSX.Element {
  return (
    <>
      <rect x={46} y={6} width={50} height={60} rx={3} className={PAGE} strokeWidth={1.5} />
      <rect x={64} y={10} width={50} height={56} rx={3} className={PAGE} strokeWidth={1.5} />
      <rect x={71} y={17} width={28} height={5} rx={2} className={ACCENT} />
      <Lines x={71} y={28} widths={[36, 32, 36, 24, 34, 28]} />
    </>
  )
}

function Data(): React.JSX.Element {
  const bars = [16, 26, 20, 34, 30, 42]
  return (
    <>
      <rect x={30} y={6} width={100} height={60} rx={4} className={PAGE} strokeWidth={1.5} />
      <rect x={38} y={13} width={34} height={4} rx={1.5} className={LINE} />
      {bars.map((h, i) => (
        <rect
          key={i}
          x={40 + i * 14}
          y={58 - h}
          width={9}
          height={h}
          rx={1.5}
          className={i === 5 ? ACCENT : SOFT}
        />
      ))}
      <path
        d="M44 44 L58 36 L72 40 L86 28 L100 30 L114 18"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary"
      />
    </>
  )
}

function Research(): React.JSX.Element {
  return (
    <>
      <rect x={24} y={8} width={34} height={44} rx={3} className={PAGE} strokeWidth={1.5} />
      <rect x={63} y={8} width={34} height={44} rx={3} className={PAGE} strokeWidth={1.5} />
      <rect x={102} y={8} width={34} height={44} rx={3} className={PAGE} strokeWidth={1.5} />
      <Lines x={29} y={15} widths={[24, 20, 22]} />
      <Lines x={68} y={15} widths={[24, 18, 22]} />
      <Lines x={107} y={15} widths={[22, 24, 18]} />
      <rect
        x={63}
        y={8}
        width={34}
        height={44}
        rx={3}
        fill="none"
        strokeWidth={2}
        className="stroke-primary"
      />
      <circle cx={80} cy={60} r={6} className={ACCENT} />
      <path
        d="M77 60 L79.5 62.5 L83.5 57.5"
        fill="none"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary-foreground"
      />
    </>
  )
}

function Checklist(): React.JSX.Element {
  return (
    <>
      <rect x={50} y={4} width={60} height={64} rx={4} className={PAGE} strokeWidth={1.5} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect
            x={57}
            y={12 + i * 13}
            width={8}
            height={8}
            rx={2}
            className={i < 2 ? ACCENT : 'fill-background stroke-muted-foreground/50'}
            strokeWidth={1.2}
          />
          <rect x={70} y={14.5 + i * 13} width={i % 2 === 0 ? 32 : 26} height={3} rx={1.5} className={LINE} />
        </g>
      ))}
    </>
  )
}

/** A game: a snake on a play field heading for an apple, with the score in the corner. */
function Game(): React.JSX.Element {
  const body: readonly (readonly [number, number])[] = [
    [52, 40],
    [60, 40],
    [68, 40],
    [76, 40],
    [76, 32],
    [84, 32],
  ]
  return (
    <>
      <rect x={36} y={6} width={88} height={60} rx={4} className={PAGE} strokeWidth={1.5} />
      <rect x={42} y={11} width={18} height={3} rx={1.5} className={LINE} />
      <rect x={104} y={11} width={14} height={3} rx={1.5} className={ACCENT} />
      {body.map(([x, y], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width={7}
          height={7}
          rx={1.5}
          className={i === body.length - 1 ? ACCENT : SOFT}
        />
      ))}
      <circle cx={107.5} cy={51.5} r={3.5} className={ACCENT} />
      <rect x={106.5} y={45} width={1.5} height={3} rx={0.75} className={LINE} />
    </>
  )
}

/** A memory game with photos: a grid of cards, two turned over showing a picture. */
function PhotoGame(): React.JSX.Element {
  return (
    <>
      {[0, 1].map((r) =>
        [0, 1, 2, 3].map((c) => {
          const open = (r === 0 && c === 1) || (r === 1 && c === 2)
          const x = 42 + c * 20
          const y = 8 + r * 29
          return (
            <g key={`${r}${c}`}>
              <rect
                x={x}
                y={y}
                width={16}
                height={25}
                rx={2.5}
                className={open ? PAGE : SOFT}
                strokeWidth={1.2}
              />
              {open && (
                <>
                  <circle cx={x + 5} cy={y + 7} r={2} className={ACCENT} />
                  <path
                    d={`M${x + 2} ${y + 21} L${x + 7} ${y + 13} L${x + 10} ${y + 17} L${x + 14} ${y + 11} L${x + 14} ${y + 21} Z`}
                    className={ACCENT}
                  />
                </>
              )}
            </g>
          )
        }),
      )}
    </>
  )
}

const PICTURE: Readonly<Record<EasyKind, () => React.JSX.Element>> = {
  app: App,
  website: Website,
  document: Document,
  data: Data,
  research: Research,
  checklist: Checklist,
  game: Game,
}

/** The picture for an example card: 160 by 72, scaled to the card's width at one fixed height. */
export function ExampleThumbnail({
  kind,
  photos = false,
  className,
}: {
  kind: EasyKind
  /** A game made with the user's own photos (the memory game example). */
  photos?: boolean
  className?: string
}): React.JSX.Element {
  const Picture = photos && kind === 'game' ? PhotoGame : PICTURE[kind]
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 160 72"
      preserveAspectRatio="xMidYMid meet"
      data-testid={`easy-thumb-${kind}${photos && kind === 'game' ? '-photos' : ''}`}
      className={cn('block h-12 w-full shrink-0 rounded-md bg-muted/60', className)}
    >
      <Picture />
    </svg>
  )
}
