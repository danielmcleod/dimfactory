// Declarations for scripts/release.mjs (release.yml's build, version and collect steps; docs/RELEASING.md).

export type ReleasePlatform = 'win' | 'mac' | 'linux'
export const PLATFORMS: readonly ReleasePlatform[]

export class ReleaseError extends Error {}

export const SIGNING_SECRETS: {
  readonly win: readonly string[]
  readonly macCertificate: readonly string[]
  readonly macApiKey: readonly string[]
  readonly macAppleId: readonly string[]
}
export function allSecretNames(): string[]
export const RELEASE_ENVIRONMENT: 'release'
export const DRY_RUN_ENVIRONMENT: 'release-dry-run'
export const REQUIRE_SIGNED_VAR: 'REQUIRE_SIGNED_RELEASE'
export function requireSigned(env: Env): boolean
export const NOTES_TEMPLATE: '.github/release-notes.md'

export function parseVersion(text: string): { base: string; prerelease: string | null } | null

export interface ResolvedRelease {
  version: string
  base: string
  tag: string | null
  prerelease: boolean
  release: boolean
}
export function resolveRelease(o: { ref: string | undefined; packageVersion: string }): ResolvedRelease

export type Env = Readonly<Record<string, string | undefined>>

export interface SigningPlan {
  platform: ReleasePlatform
  signed: boolean
  notarization: 'api-key' | 'apple-id' | null
  notes: string[]
}
export function signingPlan(platform: string, env: Env): SigningPlan
export interface SigningVerdict {
  level: 'error' | 'warning' | 'notice'
  message: string
}
export function signingVerdict(o: {
  plan: SigningPlan
  tag: string | null | undefined
  version: string
  requireSigned?: boolean
}): SigningVerdict | null
export function builderEnv(
  plan: SigningPlan,
  env: Env,
  apiKeyPath?: string,
): { set: Record<string, string>; unset: string[] }
export function builderConfig(o: {
  plan: SigningPlan
  version: string
  env: Env
  homepage?: string | null | undefined
}): Record<string, unknown>
export function repositoryHomepage(env: Env): string | null

export function expectedArtifacts(platform: string, version: string): { name: string; for: string }[]
export function packagedApps(platform: string): { arch: string; path: string }[]
export function hostPlatform(nodePlatform?: string): ReleasePlatform | null
export function sha256File(path: string): Promise<string>
export function sumsText(files: readonly { name: string; sha256: string }[]): string
export function parseSums(text: string): { name: string; sha256: string }[]

export interface ReleaseManifest {
  schemaVersion: 1
  platform: ReleasePlatform
  version: string
  signed: boolean
  signing: 'azure-artifact-signing' | 'developer-id' | 'ad-hoc' | null
  notarization: 'api-key' | 'apple-id' | null
  commit: string | null
  files: { name: string; bytes: number; sha256: string }[]
}
export function describeArtifacts(o: {
  dir: string
  platform: ReleasePlatform
  version: string
  plan: SigningPlan
  commit?: string | undefined
}): Promise<ReleaseManifest>
export function readNotesTemplate(root?: string): string
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  flags: Readonly<Record<string, boolean>>,
): string
export function releaseNotes(o: {
  version: string
  manifests: readonly ReleaseManifest[]
  commit?: string | undefined
  runUrl?: string | undefined
  template?: string | undefined
}): string
export function collectRelease(o: {
  dir: string
  version: string
  platforms?: readonly ReleasePlatform[]
  commit?: string | undefined
  runUrl?: string | undefined
  requireSigned?: boolean
  template?: string | undefined
}): Promise<{ sums: string; notes: string; files: string[]; manifests: ReleaseManifest[] }>

export function main(argv: string[]): Promise<number>
