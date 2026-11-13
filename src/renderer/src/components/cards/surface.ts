// Shared card styling (UI standard: one scroll region per screen).

/**
 * A card's text box: as tall as its text (field-sizing), from three lines up to a fixed maximum (18rem, and at most the
 * Run view's reading area less a strip of page: run/follow.tsx), past which it is an input region of its own
 * (data-scroll-region="card-input") that never scrolls the page.
 */
export const CARD_INPUT =
  'max-h-[min(18rem,var(--run-region-max,50vh))] resize-none overscroll-contain [field-sizing:content] [scrollbar-gutter:stable]'

/** A card's background: its status tint over the page as one opaque colour, which a sticky action row repeats. */
export const CARD_SURFACE = {
  blocking: 'color-mix(in oklab, var(--st-waiting) 5%, var(--background))',
  other: 'color-mix(in oklab, var(--st-stalled) 5%, var(--background))',
} as const
