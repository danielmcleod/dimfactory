# Third-party notices

Dim Factory is MIT licensed ([LICENSE](LICENSE)). It ships, or copies into your projects, the third-party pieces
below. Each keeps its own licence. The installers put this file and LICENSE in the app's `resources` folder.

## Copied into your projects by the game templates

| Piece  | Version | Licence | Where                                                                                  |
| ------ | ------- | ------- | -------------------------------------------------------------------------------------- |
| Phaser | 3.90.0  | MIT     | `src/core/templates/vendor/third-party/phaser/` (`phaser.min.js` and its `LICENSE.md`) |

A template that uses Phaser copies `phaser.min.js` into the project, with its licence text and a note listing every
copied file, its licence and its SHA-256. `src/core/templates/vendor/manifest.json` records each bundled file's licence and
SHA-256, and a unit test refuses a bundled file without a permissive licence.

**three.js is not bundled.** It is a development dependency only (for the tests of the 3D template). A 3D game project
installs its own copy with npm, under three.js's MIT licence.

## Compiled into the app

electron-vite bundles these libraries into the app's own JavaScript (the installers ship no `node_modules`):

| Library                                         | Licence                                           |
| ----------------------------------------------- | ------------------------------------------------- |
| Electron (and Chromium, Node.js, V8)            | MIT, and the licences in `LICENSES.chromium.html` |
| React, React DOM                                | MIT                                               |
| Radix UI, cmdk                                  | MIT                                               |
| Lucide icons (`lucide-react`)                   | ISC                                               |
| Zustand, Zod, marked, jsonc-parser, clsx        | MIT                                               |
| tailwind-merge                                  | MIT                                               |
| class-variance-authority                        | Apache-2.0                                        |
| @pierre/diffs (diff view)                       | Apache-2.0                                        |
| Shiki (syntax highlighting grammars and themes) | MIT                                               |
| Model Context Protocol TypeScript SDK           | MIT                                               |

Electron's own licence (`LICENSE.electron.txt`) and Chromium's (`LICENSES.chromium.html`) sit next to the app's
executable in every build. `pnpm licenses list --dev` prints the licence of every package in the dependency tree.

**Fonts:** none are bundled. The app uses the operating system's fonts (`system-ui` and the platform's monospace
font).

**Icons:** the app and tray icons are Dim Factory's own (`build/logo.svg`, `build/logo-tray.svg`). Interface icons
come from Lucide (ISC), compiled in as above.

## In the source repository only

These files are in the repository for types and tests. They are not loaded by the app at runtime.

| What                                             | Where                                          | Licence                          |
| ------------------------------------------------ | ---------------------------------------------- | -------------------------------- |
| Agent Client Protocol schema v1.25.0             | `src/core/adapters/acp-base/protocol/v1.25.0/` | Apache-2.0 (`LICENSE` beside it) |
| Codex app-server protocol types (from codex-cli) | `src/core/adapters/codex/protocol/`            | Apache-2.0, as the Codex CLI     |

**The Claude Agent SDK is not copied.** The Claude adapter's stream-json types come from `@anthropic-ai/claude-agent-sdk`,
a development dependency pinned to an exact version and imported as types only (`import type`), so nothing of it is
in this repository, the app or the installers. pnpm installs it under its own terms, and never its optional
per-platform packages (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`).
