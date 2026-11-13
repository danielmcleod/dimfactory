// Isolated-run prepare (Prepare steps 2 to 5; verify:0;
// run.deps, run.isolation.verifyReady): copy-ins, deps detection and install (with `deps` trust), the verify:0
// baseline and verify readiness. Step 1 (the worktree itself) is git/worktree.ts.
export { DEPS_MANAGERS, decideDeps, detectDeps, planCommands, planFromCommand } from './detectDeps.ts'
export type { DepsDecision, DepsManager, DepsPlan, DetectDepsOptions, InstallSettings } from './detectDeps.ts'
export { checkDepsTrust, depsGrantCommand, depsHash, depsTrustOf, grantDeps, readDepsBody } from './trust.ts'
export type { DepsBodyRead, DepsTrustCheck, DepsTrustRead } from './trust.ts'
export { DEPS_INSTALL_TIMEOUT_MS, depsLogPaths, prepareLogDir, runInstall } from './install.ts'
export type {
  InstallDeps,
  InstallOptions,
  InstallOutputEvent,
  InstallResult,
  InstallStatus,
  InstallStepResult,
} from './install.ts'
export {
  COPY_IN_MAX_BYTES,
  COPY_IN_MAX_FILES,
  COPY_IN_MAX_VISITED,
  copyIns,
  expandBraces,
  gitTrackedFiles,
} from './copyIns.ts'
export type { CopyInOptions, CopyInResult, CopyInSkip, TrackedFiles } from './copyIns.ts'
export {
  baselineCommands,
  baselineOf,
  baselinePath,
  readBaseline,
  runBaseline,
  uniqueNames,
  wantsBaseline,
  writeBaseline,
} from './baseline.ts'
export type { BaselineDeps, BaselineOptions, BaselineResult, VerifyBaseline } from './baseline.ts'
export { VERIFY_READY_CHECK_ID, checkVerifyReady, verifyReadyResult, wantsVerifyReady } from './readiness.ts'
export type { VerifyReadyCommand, VerifyReadyOptions, VerifyReadyReport } from './readiness.ts'
export { changedSources, readDepsFacts, resolveTools } from './facts.ts'
export type { DepsFacts, DepsFactsOptions, DepsToolFact } from './facts.ts'
export { copyInsSummary, decideDepsStage, depsCommandView, installSummary } from './stage.ts'
export type { DepsCommandFacts, DepsSource, DepsStageOptions, DepsStageResult } from './stage.ts'
