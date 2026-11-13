// Prove it end to end with the fake Claude: the real adapter spawns it under Approve everything with Dim Factory's
// hook, in a folder under the home that is gone afterwards. A refusal reads as held, a changed file as broken and a
// session that never tried as unclear; each is kept in proofs.json with the CLI version, one per rule.
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { proofsPath, proveRule, readProofs } from '../../../src/core/guardrails/prove.ts'
import { homePaths } from '../../../src/core/home.ts'
import { proofNeedsRetest } from '../../../src/shared/guardrails.ts'
import { LOCAL, STDIO, fakeAdapter, fakeSetup } from '../adapters/helpers.ts'

const HERE = fileURLToPath(new URL('./fixtures/', import.meta.url))

function scenario(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'prove-scenario-'))
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
      {
        match: { argvIncludes: ['auth', 'status'] },
        script: join(LOCAL, 'auth-status.script.jsonl'),
        repeat: true,
      },
      // The proof runs under Approve everything; the probe's handshake does not.
      { match: { argvIncludes: ['bypassPermissions'] }, script: join(HERE, script), repeat: true },
      {
        match: { argvIncludes: ['-p'] },
        script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
        repeat: true,
      },
    ]),
  )
  return dir
}

async function prove(script: string, home = mkdtempSync(join(tmpdir(), 'prove-home-'))) {
  const fs = await fakeSetup()
  const adapter = fakeAdapter(fs, { vendorEnv: { FAKE_CLI_SCRIPT: scenario(script) } })
  const proof = await proveRule({ home, adapter, model: 'haiku', now: () => 1_000 }, 'protectedFiles')
  return { proof, home }
}

const proofFolders = (home: string): string[] => {
  const dir = join(homePaths(home).tmpDir, 'guardrail-proof')
  return existsSync(dir) ? readdirSync(dir) : []
}

describe('Prove it on Claude (fake CLI)', () => {
  it('reads a refusal as held, records it with the CLI version, and leaves no folder behind', async () => {
    const { proof, home } = await prove('prove-held.script.jsonl')
    expect(proof).toMatchObject({
      kind: 'protectedFiles',
      vendor: 'claude',
      result: 'held',
      at: 1_000,
      model: 'haiku',
    })
    expect(proof.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(await readProofs(home)).toEqual([proof])
    expect(existsSync(proofsPath(home))).toBe(true)
    expect(proofFolders(home)).toEqual([])
    expect(proofNeedsRetest(proof, proof.version)).toBe(false)
    expect(proofNeedsRetest(proof, '9.9.9')).toBe(true)
  }, 120_000)

  it('reads a changed file as broken, and keeps one proof per rule', async () => {
    const first = await prove('prove-held.script.jsonl')
    const { proof } = await prove('prove-broken.script.jsonl', first.home)
    expect(proof.result).toBe('broken')
    expect(proof.detail).toBe('protected.txt was changed.')
    expect(await readProofs(first.home)).toEqual([proof])
  }, 120_000)

  it('reads a session that never tried as unclear', async () => {
    const { proof } = await prove('prove-unclear.script.jsonl')
    expect(proof.result).toBe('unclear')
  }, 120_000)
})
