// Coverage: where a GUI-launched Dim Factory looks for CLIs a user installed with a version manager
// (PATH: the login shell's PATH plus well-known bin folders; nvm's newest installed Node). The newest version is
// picked by number, not by name, so v20.11 beats v20.9.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { posixExtraDirs } from '../../../src/core/proc/path-env.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

async function nvm(names: string[]): Promise<string> {
  const user = join(home(), 'user')
  const versions = join(user, '.nvm', 'versions', 'node')
  await mkdir(versions, { recursive: true })
  for (const n of names) {
    if (n.startsWith('.')) await writeFile(join(versions, n), '')
    else await mkdir(join(versions, n))
  }
  return user
}

describe('posixExtraDirs', () => {
  it("takes nvm's numerically newest Node (v20.11.1 over v20.9.0), ignoring entries that are not versions", async () => {
    const user = await nvm(['v18.20.4', 'v20.9.0', 'v20.11.1', 'system', '.DS_Store', 'default'])
    const dirs = posixExtraDirs(user, () => true)
    expect(dirs).toContain(posix.join(user, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'))
    expect(dirs.filter((d) => d.includes(`${posix.sep}.nvm${posix.sep}`))).toHaveLength(1)
  })

  it('accepts versions without the v prefix and orders by major, then minor, then patch', async () => {
    const user = await nvm(['9.11.2', '10.0.0', '10.0.10', '10.0.9'])
    expect(posixExtraDirs(user, () => true)).toContain(
      posix.join(user, '.nvm', 'versions', 'node', '10.0.10', 'bin'),
    )
  })

  it('no nvm folder, or one without versions: no nvm entry', async () => {
    const bare = join(home(), 'bare')
    await mkdir(bare, { recursive: true })
    expect(posixExtraDirs(bare, () => true).some((d) => d.includes('.nvm'))).toBe(false)
    const empty = await nvm(['system'])
    expect(posixExtraDirs(empty, () => true).some((d) => d.includes('.nvm'))).toBe(false)
  })

  it('keeps only the folders that exist, in the documented order', async () => {
    const user = await nvm(['v22.1.0'])
    const present = new Set([
      posix.join(user, '.local', 'bin'),
      '/usr/local/bin',
      posix.join(user, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'),
      '/snap/bin',
    ])
    expect(posixExtraDirs(user, (p) => present.has(p))).toEqual([
      posix.join(user, '.local', 'bin'),
      '/usr/local/bin',
      posix.join(user, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'),
      '/snap/bin',
    ])
  })
})
