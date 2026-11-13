// Testing Library setup for renderer tests that render React: the project runs without vitest globals, so React's
// act environment flag and the per-test DOM cleanup are wired here. Import it first in any test that renders.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
})
