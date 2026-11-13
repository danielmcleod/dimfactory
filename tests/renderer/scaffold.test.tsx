// The renderer test project (happy-dom + Testing Library) is wired up: JSX compiles and renders into the DOM.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('renderer test project', () => {
  it('renders JSX into happy-dom', () => {
    render(<p>dim-factory</p>)
    expect(screen.getByText('dim-factory').tagName).toBe('P')
  })
})
