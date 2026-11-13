# Releasing Dim Factory

How a Dim Factory release is built. The pipeline is
[`.github/workflows/release.yml`](../.github/workflows/release.yml); the decisions it makes (version, signing, file
names, checksums, release notes) live in [`scripts/release.mjs`](../scripts/release.mjs), which has unit tests in
`tests/unit/release/`. Packaging itself is [`electron-builder.yml`](../electron-builder.yml), and the draft release's
text comes from [`.github/release-notes.md`](../.github/release-notes.md).

Releases are **unsigned for now**: the Windows installer is unsigned, the macOS apps carry an ad hoc signature (not a
Developer ID, not notarized), and the Linux packages are covered by `SHA256SUMS`, as they always are. Everything runs
on free GitHub Actions with no secrets at all. The first launch of an unsigned build shows a warning on Windows and
macOS; the README's [install notes](../README.md#installing) say how to get past it once (on macOS: System
Settings, Privacy & Security, Open Anyway). Code signing is built in but
dormant: it turns on when its secrets are added ([Turning on signing](#turning-on-signing)).

## What a release contains

| File                                    | For                              | Signature                                    |
| --------------------------------------- | -------------------------------- | -------------------------------------------- |
| `dim-factory-setup-<version>.exe`       | Windows 10 and 11, x64 (NSIS)    | Not signed                                   |
| `dim-factory-<version>-arm64.dmg`       | macOS, Apple silicon             | Ad hoc signed, not notarized                 |
| `dim-factory-<version>-x64.dmg`         | macOS, Intel                     | Ad hoc signed, not notarized                 |
| `dim-factory_<version>_amd64.deb`       | Ubuntu and Debian, x64 (primary) | checksum only; installs the AppArmor profile |
| `dim-factory-<version>-x86_64.AppImage` | other Linux, x64                 | checksum only                                |
| `SHA256SUMS`                            | every file above                 |                                              |

Once signing is turned on, the Windows row reads "Azure Artifact Signing" and the macOS rows "The app inside:
Developer ID, notarized and stapled"; the release notes always say which it is.

Apple silicon Macs refuse to run an app with no signature at all, so an unsigned macOS build is signed ad hoc:
electron-builder's `mac.identity: "-"` (set by `scripts/release.mjs` for every build without a Developer ID), which
signs each binary in the bundle without a certificate. `identity: null` would skip signing
entirely and is not used.

There is no auto-update and no update feed: a new version is downloaded and installed by hand.

## How a release is built

Every push and pull request runs `ci.yml` on Windows, macOS and Linux (unit, integration, renderer and E2E tests, the
packaged-app smoke test). It needs no secrets.

A tag `v*` runs `release.yml`:

1. **prepare**: reads the version from the tag. `vX.Y.Z` or `vX.Y.Z-pre` must carry package.json's `X.Y.Z`, or the
   run stops here.
2. **build** (Windows, macOS and Ubuntu, in parallel): the unit tests, `pnpm build`, then `scripts/release.mjs build`,
   which runs electron-builder for that OS. Without signing secrets it builds unsigned (macOS: ad hoc) and logs
   "Signing skipped". Each OS checks the signatures it made, the fuse wire of each packaged app, and runs the packaged
   app's own `--smoke-test` on the very build that was packaged.
3. **smoke (mac, Intel)**: mounts the Intel dmg the macOS build uploaded, on an Intel Mac runner, checks its signature
   and runs the app's `--smoke-test` from it. The macOS build's own runner is Apple silicon and smoke-tests that app.
4. **release** (tags only): checks every installer against its build's manifest, writes one `SHA256SUMS`, fills in
   `.github/release-notes.md`, and creates a **draft** GitHub release with the installers, `SHA256SUMS` and those
   notes. Nothing is public until the draft is published.

A manual run on a branch is a dry run: it builds and checks the three OSes in the `release-dry-run` environment, which
holds no secrets, keeps the files as workflow artifacts, and never runs the release job.

## Cutting a release

1. CI is green on the commit on Windows, macOS and Linux, and package.json's `version` is the release's `X.Y.Z`.
2. Tag a release candidate first. Its draft is marked as a pre-release and its files are named `1.0.0-rc.1`:

   ```sh
   git tag -a v1.0.0-rc.1 -m "Dim Factory v1.0.0-rc.1"
   git push origin v1.0.0-rc.1
   ```

3. Download the draft's files, check them ([Verifying the files](#verifying-the-files)) and install them. A fix goes
   on a new commit, with the next candidate (`v1.0.0-rc.2`).
4. Tag the release on the commit the candidate checked out:

   ```sh
   git tag -a v1.0.0 v1.0.0-rc.1^{} -m "Dim Factory v1.0.0"
   git push origin v1.0.0
   ```

   A final tag builds unsigned like the candidate, unless the repository variable `REQUIRE_SIGNED_RELEASE` is `true`
   ([Turning on signing](#turning-on-signing)): then a final tag whose Windows or macOS build would be unsigned fails
   at the build step, before building anything, naming the secrets to set.

5. Check the draft's files again (they were rebuilt), read the notes, then **Publish release**.

## Verifying the files

Download the files and `SHA256SUMS` into one folder, then:

```sh
sha256sum --check --ignore-missing SHA256SUMS          # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS      # macOS
```

```powershell
Get-FileHash .\dim-factory-setup-1.0.0.exe -Algorithm SHA256   # Windows: compare with the line in SHA256SUMS
```

## Turning on signing

Signing is per OS and dormant until every secret that OS needs is set: `scripts/release.mjs` then signs (Windows) or
signs and notarizes (macOS) on the next tag, with no change to the workflow. Some of an OS's secrets set and others
missing fails the build and names the missing ones, so a half-finished setup never ships silently unsigned. After
turning signing on, edit the first-launch steps in the README's [Installing](../README.md#installing) section; the
release notes adjust themselves.

### Secrets

The signing secrets are **environment secrets** of an environment named `release`, which only a `v*` tag run can
reach:

1. Settings → Environments → New environment: `release`.
2. Deployment branches and tags: **Selected branches and tags**, then add a rule of type **Tag** with the pattern
   `v*`. No branch rule.
3. Add each secret below under that environment's "Environment secrets" (or `gh secret set <NAME> --env release`),
   never as repository or organization secrets: those reach every workflow run on every branch.
4. Leave `release-dry-run` alone: it holds no secrets, so dry runs build unsigned.

Set all of an OS's secrets or none of them.

| Secret | OS | What it holds |
| ------ | -- | ------------- |
| `AZURE_TENANT_ID` | Windows | Entra tenant (directory) id of the signing app registration |
| `AZURE_CLIENT_ID` | Windows | The app registration's application (client) id |
| `AZURE_CLIENT_SECRET` | Windows | A client secret of that app registration |
| `AZURE_SIGNING_ENDPOINT` | Windows | The Artifact Signing account URI, for example `https://eus.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT` | Windows | The Artifact Signing account name |
| `AZURE_SIGNING_CERT_PROFILE` | Windows | The certificate profile name |
| `AZURE_SIGNING_PUBLISHER` | Windows | The certificate subject's common name (required by electron-builder) |
| `MAC_CSC_LINK` | macOS | The Developer ID Application certificate and key, `.p12`, base64 |
| `MAC_CSC_KEY_PASSWORD` | macOS | The `.p12` password |
| `APPLE_API_KEY_P8` | macOS | Notarization, API key set: the contents of `AuthKey_<KEY ID>.p8` |
| `APPLE_API_KEY_ID` | macOS | Notarization, API key set: the Key ID |
| `APPLE_API_ISSUER` | macOS | Notarization, API key set: the Issuer ID |
| `APPLE_ID` | macOS | Notarization, Apple ID set: the Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | Notarization, Apple ID set: an app-specific password |
| `APPLE_TEAM_ID` | macOS | Notarization, Apple ID set: the 10-character Team ID |

One **repository variable** (Settings → Secrets and variables → Actions → Variables), not a secret:

| Variable                 | Values          | Effect                                                                                       |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `REQUIRE_SIGNED_RELEASE` | unset or `true` | `true`: a final tag (`vX.Y.Z`) fails before building when Windows or macOS would be unsigned |

Set it once both OSes sign, so a lost secret can never ship an unsigned final release.

### Windows: Azure Artifact Signing

1. In an Azure subscription, register the `Microsoft.CodeSigning` resource provider and create an **Artifact Signing
   account**. Its account URI is the endpoint.
2. Complete **identity validation** in the portal, then create a **certificate profile** of type Public Trust on the
   validated identity.
3. In Microsoft Entra ID, create an **app registration** with a **client secret**, and give it the "Artifact Signing
   Certificate Profile Signer" role on the certificate profile.
4. Store the seven Windows secrets above.

### macOS: Developer ID and notarization

1. An Apple Developer Program membership and a **Developer ID Application** certificate, exported with its private
   key as a `.p12`. Store `base64 -i DeveloperID.p12` as `MAC_CSC_LINK` and its password as `MAC_CSC_KEY_PASSWORD`.
2. One notarization set: an App Store Connect API key (`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`;
   preferred), or an Apple ID with an app-specific password (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`).

With the certificate set, the build signs with the Developer ID and the hardened runtime
(`build/entitlements.mac.plist`), notarizes and staples both apps, and checks them with `codesign`, `spctl` and
`stapler`. A notarized app opens without the Privacy & Security step.

### Linux

Nothing to set up: the deb and the AppImage are not signed, and `SHA256SUMS` covers them.

## Building locally

`pnpm package` builds this OS's installers, unsigned, into `dist/` (on Windows: `dist/dim-factory-setup-<version>.exe`).
`pnpm package:dir` builds only the unpacked app, which `pnpm smoke:packaged` launches with `--smoke-test`.

The release path can run locally too, unsigned (macOS: ad hoc) unless the secrets are in your environment:

```sh
pnpm build
node scripts/release.mjs build --platform win --version 1.0.0     # or mac; linux also needs --homepage <url>
```

electron-builder builds each OS's installers only on that OS, so a full release needs the workflow.
