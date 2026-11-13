// Verify step public surface: discovery, trust hashing, resolution, round
// execution, excerpts, the {{verify}} section and the round's findings.
export type {
  DetectedCommand,
  VerifyCommand,
  VerifyCommandResult,
  VerifyKind,
  VerifyResultStatus,
  VerifySource,
  VerifyTrustState,
} from '../../shared/verify.ts'
export { VERIFY_DEFAULT_TIMEOUT_MS } from '../../shared/verify.ts'
export { commandArgv, displayArgv, quoteArg, tokenizeCommandLine } from './argv.ts'
export type { ArgvResult } from './argv.ts'
export { classifyEnvFailure, envFailureHint, hasFailureMarkers } from './classify.ts'
export type { EnvClassifyInput } from './classify.ts'
export {
  NPM_TEST_STUB,
  configCommands,
  cwdRelOf,
  detectPackageManager,
  discoverCommands,
  readBody,
  readCommandBody,
  scriptsBody,
} from './discover.ts'
export type {
  BodyCommand,
  BodyRead,
  ConfigCommandsOptions,
  DiscoverOptions,
  PackageManager,
} from './discover.ts'
export {
  buildExcerpt,
  cleanLine,
  ExcerptCollector,
  EXCERPT_MAX_BYTES,
  EXCERPT_TAIL_LINES,
} from './excerpt.ts'
export { CappedLog, LIVE_TAIL_BYTES, LOG_HEAD_BYTES, LOG_TAIL_BYTES, LiveTail } from './log.ts'
export {
  VERIFY_SECTION_CAP_BYTES,
  fencedExcerpt,
  formatVerifyDuration,
  renderVerifySection,
  verifyFindings,
  verifyHasMustFailures,
} from './render.ts'
export type { VerifyBaseline, VerifyFindingsOptions } from './render.ts'
export { localBinDirs, resolveCommand } from './resolve-cmd.ts'
export type { ResolveCommandOptions, ResolvedCommand } from './resolve-cmd.ts'
export { runVerifyRound, verifyChildEnv, verifyLogName, verifyRoundDir } from './run.ts'
export type {
  VerifyDeps,
  VerifyOutputEvent,
  VerifyRoundCommand,
  VerifyRoundKey,
  VerifyRoundOptions,
  VerifyRoundResult,
} from './run.ts'
export { argvOfCommand, checkTrust, commandHash, grantCommandOf, trustOf } from './trust.ts'
export type { TrustCheck } from './trust.ts'
export { detectVerifyCommands } from './detect.ts'
export type { DetectVerifyOptions } from './detect.ts'
export { PLAYTEST_NOT_HERE, PLAYTEST_NO_FILE, readPlaytestFile, runPlaytest } from './playtest.ts'
export type { Playtester, PlaytestOutcome, PlaytestRequest } from './playtest.ts'
