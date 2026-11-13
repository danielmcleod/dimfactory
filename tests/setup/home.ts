// Per-test isolated DIM_FACTORY_HOME.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

let home: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dim-factory-test-'))
  process.env['DIM_FACTORY_HOME'] = home
})

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  home = undefined
  delete process.env['DIM_FACTORY_HOME']
})
