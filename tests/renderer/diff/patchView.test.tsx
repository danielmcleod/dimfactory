// The real @pierre/diffs view behind the Diff tab ("One scroll region per screen"): core's
// patch for one file laid out on the main thread (no worker in happy-dom), lines wrapped and the code column never a
// sideways scroller, the app's --diff-* tokens and fonts on the view, Split or Stacked, the app's light or dark theme,
// and a patch the library cannot read shown as text rather than a blank.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PatchView } from '@renderer/components/diff/PatchView.tsx'
import { patchFor } from './helpers.tsx'

async function settleView(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })
}

function host(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('diffs-container')
  if (el === null) throw new Error('no diffs-container')
  return el
}

describe('PatchView (@pierre/diffs)', () => {
  it("lays core's patch out, wrapped, in the app's tokens", async () => {
    const { container } = render(
      <PatchView patch={patchFor('src/a.ts')} cacheKey="k1" layout="split" theme="light" worker={false} />,
    )
    await settleView()
    const el = host(container)
    expect(el.style.getPropertyValue('--diffs-addition-color-override')).toBe('var(--diff-add)')
    expect(el.style.getPropertyValue('--diffs-deletion-color-override')).toBe('var(--diff-del)')
    expect(el.style.getPropertyValue('--diffs-bg-addition-override')).toBe('var(--diff-add-bg)')
    expect(el.style.getPropertyValue('--diffs-bg-deletion-override')).toBe('var(--diff-del-bg)')
    expect(el.style.getPropertyValue('--diffs-font-family')).toBe('var(--font-mono)')
    expect(el.style.getPropertyValue('--diffs-overflow-override')).toBe('clip')
    const shadow = el.shadowRoot
    expect(shadow).not.toBeNull()
    const pre = shadow?.querySelector('pre[data-overflow]')
    expect(pre?.getAttribute('data-overflow')).toBe('wrap')
    expect(pre?.getAttribute('data-diff-type')).toBe('split')
    expect(shadow?.textContent).toContain('const b = 3')
  })

  it('stacked is the unified layout', async () => {
    const { container } = render(
      <PatchView patch={patchFor('src/a.ts')} cacheKey="k2" layout="stacked" theme="dark" worker={false} />,
    )
    await settleView()
    expect(
      host(container).shadowRoot?.querySelector('pre[data-diff-type]')?.getAttribute('data-diff-type'),
    ).toBe('single')
  })

  it('a patch it cannot read shows as text', () => {
    render(<PatchView patch="not a patch at all" cacheKey="k3" layout="split" theme="light" worker={false} />)
    expect(screen.getByTestId('diff-plain').textContent).toContain('not a patch at all')
    expect(screen.getByTestId('diff-plain').textContent).toContain('shown as text')
  })
})
