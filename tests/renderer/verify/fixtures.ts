// Verify renderer fixtures: verify rounds (StepView.verify), the trust and verifyEnv cards as core builds them
// (src/core/supervisor/cards.ts trustCard / verifyEnvCard), and verify.detect answers (src/shared/verify.ts).
import type { CardView, StepView, VerifyCommandView } from '@shared/run.ts'
import type { VerifyCommand } from '@shared/verify.ts'

export const TYPECHECK: VerifyCommandView = {
  name: 'typecheck',
  argv: ['pnpm', 'run', 'typecheck'],
  status: 'pass',
  exitCode: 0,
  durationMs: 12_000,
}

export const TEST_FAIL: VerifyCommandView = {
  name: 'test',
  argv: ['pnpm', 'run', 'test'],
  status: 'fail',
  exitCode: 1,
  durationMs: 41_000,
  excerpt: 'FAIL src/cli.test.ts\n  expected "1.2.0" to be "1.3.0"\nTests: 1 failed, 12 passed',
}

export function verifyStep(
  over: Partial<StepView> & { commands?: VerifyCommandView[] } = {},
): Partial<StepView> {
  const { commands, ...rest } = over
  return {
    status: 'done',
    attempt: 1,
    activeMs: 53_000,
    ...(commands !== undefined ? { verify: { commands } } : {}),
    ...rest,
  }
}

export function trustCard(
  over: { changed?: boolean; withDiff?: boolean; body?: string | null } = {},
): CardView {
  const body = over.body === undefined ? 'vitest run --reporter=dot' : over.body
  const changed = over.changed === true
  const payload: Record<string, unknown> = {
    step: 'verify:1',
    name: 'test',
    argv: ['pnpm', 'run', 'test'],
    cwdRel: '.',
    command: 'pnpm run test',
    body,
    trust: changed ? 'changed' : 'untrusted',
  }
  if (changed) {
    payload['grantedBody'] = 'vitest run'
    if (over.withDiff !== false) {
      payload['diff'] = [
        { op: 'del', text: 'vitest run' },
        { op: 'add', text: 'vitest run --reporter=dot' },
      ]
    }
  }
  const text = changed
    ? 'The script behind `pnpm run test` changed since you trusted it, so Verify does not run it until you trust it again.\n\nChanges:\n- vitest run\n+ vitest run --reporter=dot\n\nTrust it to run it now and in later runs until its script changes, or skip it this round.'
    : 'Verify wants to run `pnpm run test` in the project folder after Implement. Dim Factory runs only the commands you trust for this project.\n\nScript: vitest run --reporter=dot\n\nTrust it to run it now and in later runs until its script changes, or skip it this round.'
  return {
    id: 'trust-1',
    kind: 'trust',
    title: changed ? 'The test check changed since you trusted it' : 'Trust the test check?',
    body: text,
    payload,
    blocking: true,
    choices: [
      { id: 'trust', label: 'Trust for this project', primary: true },
      { id: 'skip', label: 'Skip' },
    ],
  }
}

export function verifyEnvCard(over: { failure?: string } = {}): CardView {
  if (over.failure !== undefined) {
    return {
      id: 'verifyEnv-1',
      kind: 'verifyEnv',
      title: 'Verify could not run',
      body: `Verify could not run: ${over.failure}\n\nRetry, or skip verify to go on without it.`,
      payload: { step: 'verify:1', commands: [], failure: over.failure },
      blocking: true,
      defaultChoice: 'skip-verify',
      choices: [
        { id: 'retry', label: 'Retry', primary: true },
        { id: 'skip-verify', label: 'Skip verify' },
      ],
    }
  }
  return {
    id: 'verifyEnv-1',
    kind: 'verifyEnv',
    title: 'The lint check could not run',
    body: 'These checks could not run in this environment (a missing program or module, for example), so they are not findings:\n- lint (`eslint .`): eslint was not found.\n\nFix the environment and retry, or skip verify to go on without them.',
    payload: {
      step: 'verify:1',
      commands: [
        {
          name: 'lint',
          argv: ['eslint', '.'],
          command: 'eslint .',
          exitCode: 9009,
          reason: 'eslint was not found.',
          excerpt: "'eslint' is not recognized as an internal or external command",
        },
      ],
    },
    blocking: true,
    defaultChoice: 'skip-verify',
    choices: [
      { id: 'retry', label: 'Retry', primary: true },
      { id: 'skip-verify', label: 'Skip verify' },
    ],
  }
}

export function detected(over: Partial<VerifyCommand> & { name: string }): VerifyCommand {
  const argv = over.argv ?? over.run ?? ['pnpm', 'run', over.name]
  return {
    id: `${over.source ?? 'package.json'}:.:${over.name}`,
    run: argv,
    argv,
    cwdRel: '.',
    source: 'package.json',
    kind: 'test',
    enabledByDefault: true,
    body: `vitest run # ${over.name}`,
    timeoutMs: 600_000,
    hash: 'a'.repeat(64),
    trust: 'untrusted',
    trusted: false,
    resolved: 'C:\\work\\repo\\node_modules\\.bin\\pnpm.cmd',
    configured: false,
    ...over,
  }
}
