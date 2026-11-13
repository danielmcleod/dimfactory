# Renderer infrastructure

What the page agents (Run view, Shell + Dashboard, later Settings) build on. One rule binds them: **the renderer never
derives statuses, phases, costs, findings or estimates** — it formats `RunSummary` / `RunSnapshot` / `StepView` /
`Estimate` from core. Imports: only `@shared/*` (types and pure constants) and files under `src/renderer/src`. Never
import values from `@shared/config-schema.ts` (it pulls zod into the bundle); `import type` is fine.

```
main.tsx            applies main's initialTheme to <html>, then renders <App/> in StrictMode
app/App.tsx         TooltipProvider · banners · <Shell><RoutedPage/></Shell> · Toaster · Ctrl/⌘+1/2/3
app/Banners.tsx     lost contact · quit requested · runs paused because Dim Factory closed
ipc/client.ts       typed invoke (never rejects), call/unwrap/IpcError, invokeCall, subscribeEvents, logToMain
ipc/bridge.ts       push channel → store + streamBuffer; focus protocol; heartbeat watchdog
state/              one zustand store (store.ts), mutations (actions.ts), hooks (selectors.ts),
                    snapshot loading (runs.ts), toasts (toasts.ts)
lib/                streamBuffer, router, ticker, format, keys, linediff, theme, cn
components/ui/      shadcn-style primitives (cva + cn, Radix from 'radix-ui')
styles/             index.css (Tailwind 4 + token mapping), tokens.css (OKLCH, light/dark, accents)
```

Page entry points (owned by the page agents; keep these signatures):
`components/shell/Shell.tsx` `Shell({children})`, `pages/dashboard/DashboardPage.tsx` `DashboardPage()`,
`pages/run/RunPage.tsx` `RunPage({runId, tab}: {runId: string; tab: RunTab})` (mounted with `key={runId}`),
`pages/runs/RunsPage.tsx` `RunsPage()`, `pages/settings/SettingsPage.tsx` `SettingsPage({section}: {section?: string})`.
App renders banners above the shell, so the shell fills the remaining height (`h-full`); `<main>` scrolls.

## IPC — `ipc/client.ts`

| Export                            | Use                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke(cmd, req?)`               | `Promise<Result<Res<C>>>`; never rejects. No bridge (scaffold preload, tests) or a failed IPC call → `{ok:false, error:{code:'INTERNAL'}}`. |
| `call(cmd, req?)`                 | invoke + unwrap: resolves to the value or rejects with `IpcError` (`code`, `details`, `cmd`, `message` = core's text).                      |
| `unwrap(result, cmd?)`            | value of an ok Result, else throws `IpcError`.                                                                                              |
| `invokeCall(c: CommandCall)`      | run a prepared `{cmd, req}` (toast actions, recovery buttons).                                                                              |
| `getDimFactory()` / `hasBridge()` | the preload API when usable, else null/false.                                                                                               |
| `subscribeEvents(cb)`             | raw AppEvent batches (the bridge already routes them; prefer the store).                                                                    |
| `logToMain(level, msg, data?)`    | fire-and-forget `log.write`.                                                                                                                |

Show core's error message as is (`r.error.message`); it is written for users.

## Bridge and stream focus — `ipc/bridge.ts`

`App` calls `startBridge()` in an effect (idempotent, StrictMode-safe). Start-up: subscribe first (buffering),
`app.info` + `runs.list({status: active})` + `runs.list({limit: 50})` + `vendors.list`, `runs.get` for each active run,
then drain the buffer (envelopes with seq ≤ the snapshot's `lastSeq` are dropped), send `events.focus`, and call
`app.ready({route})` once.

**Focus your run.** Main forwards `{t:'ev'}` stream envelopes only for focused runs (asks always). A component that
shows a run's stream in full must hold focus while mounted:

```tsx
useFocusRun(runId) // RunPage: ref-counted, released on unmount
const release = focusRun(id) // imperative form; call release() when done
setFocusedRuns(ids) // replaces the explicit set (in addition to focusRun holders)
focusedRunIds()
```

When a run becomes focused the bridge sends `events.focus`, waits for it, then replays the run's log with
`runs.events` from what the stream buffer already has (paged by 1000 until `!more`; `condensed` is not used because
core ignores it), with live envelopes queued behind the replay. A gap (`seq > last + 1`) in a focused run triggers one
paged catch-up; `resync` refetches snapshots and catches focused runs up. Seq idempotence in the stream buffer makes
replay + live delivery exact (reload-mid-stream.spec.ts). Unfocused runs get structural envelopes only.

Every structural envelope (anything but a stream event; an ask counts as structural) schedules a debounced
`runs.get` (120 ms trailing, at least once per 1 s under load, one request in flight per run) that **replaces** the
snapshot. Never patch a snapshot locally; call `fetchSnapshot(runId)` after a command if you need it sooner.

No event for 15 s → `app.lostContact` (banner); the next event clears it. Hidden windows do not trip it.

Push routing: `run-summary` → summaries · `attention` → attention · `probe` → probes · `theme` → `<html>` + store ·
`toast` → toasts (a gate's, `skipInRunView`, is left out while that run's view is open) · `app` quit-requested → `app.quitRequested`, recovered → `app.notices`, unclean-exit → warn toast ·
`config-changed` → `app.configEpoch` + 1 (refetch config views when it changes) · `catalog` → `state/catalog.ts`
`onCatalogEvent`.
`attention` and `theme` are sent on change only, so main sends both again after every `app.ready` (first load, reload,
crash reload); the renderer never fetches them itself.

E2E: when `AppInfo.e2e` is true the bridge installs `window.__dimFactoryE2E` (`E2E_HOOK`):
`{ streamText(runId, step, attempt?), streamLastSeq(runId), focusedRuns(), flushStreams(), toast(input) }`. `streamText`
is the full concatenated text of a stream, including text dropped by the 400-block cap (compare it with the fixture for
reload-mid-stream.spec.ts); `toast` shows a toast as `state/toasts.ts` does (ui-layout.spec.ts's burst).

## Store — `state/`

`useStore` (zustand) slices:

| Slice       | Shape                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`       | `info: AppInfo \| null`, `theme`, `bridge: 'idle'\|'starting'\|'ready'\|'unavailable'`, `lostContact`, `quitRequested: {activeRuns, runIds} \| null`, `notices: {id, kind:'recovered', runIds, detail?}[]`, `configEpoch` |
| `summaries` | `byId: Record<runId, RunSummary>`, `order` (newest first), `loaded`, `error?`                                                                                                                                             |
| `runs`      | `byId: Record<runId, {snapshot: RunSnapshot \| null; lastSeq; status: 'idle'\|'loading'\|'ready'\|'error'; error?}>`                                                                                                      |
| `attention` | `{needsYou, items: AttentionItem[]}` from core                                                                                                                                                                            |
| `probes`    | `byVendor: Record<vendor, ProbeView>`, `order`                                                                                                                                                                            |
| `toasts`    | `items: ToastItem[]`                                                                                                                                                                                                      |
| `catalog`   | `state` (the last whole `CatalogState`), `status` (core's newest `CatalogStatus`, also from dashboard.get), `job` (the refresh job, also from `catalog` events), `epoch` (bumped when prices change)                      |

Hooks (`state/selectors.ts`, all return stable identities): `useAppInfo`, `useTheme`, `useBridgeState`,
`useLostContact`, `useQuitRequested`, `useNotices`, `useConfigEpoch`, `useSummary(runId)`, `useSummariesLoaded`,
`useRunIds('all'|'active'|'finished', limit?)`, `useActiveRunCount`, `useRunEntry(runId)`,
`useRun(runId)` (loads the snapshot on mount), `useAttention`, `useNeedsYou`, `useProbe(vendor)`, `useProbes`,
`useToasts`. `ACTIVE_RUN_STATUSES` / `isActiveStatus` = queued, running, waiting, paused. Need a different slice?
Select it with `useStore(selector)` and `useShallow` for arrays; keep selectors cheap.

Actions (`state/actions.ts`): `upsertSummaries(list)` (e.g. a Runs page `runs.list` page), `removeRuns(ids)` (after
`runs.remove`), `applySnapshot(snap)` (ignores a snapshot older than the one held), `dismissNotice(id)`,
`setQuitRequested(null)`, `upsertProbes(views)` (after `vendors.probe`). Snapshot loading (`state/runs.ts`):
`ensureRun(runId)`, `fetchSnapshot(runId)` (now), `scheduleRefetch(runId)` (debounced).

### Toasts — `state/toasts.ts` + `<Toaster/>` (mounted by App)

```ts
toast({ level: 'info'|'warn'|'error', message, action?, durationMs?, id? }): string
// action: { label, call: CommandCall } | { label, onClick }, optional disabledReason (shown disabled with a tooltip),
//   optional liveDisabledReason(storeState) (re-read while the toast shows: the Stop toast's Revert all)
// durationMs: default info 5 s, warn 8 s, error 10 s (≥ 8 s with an action); null = until dismissed
// id: reuse to replace a toast in place
dismissToast(id)
```

Stacked bottom right (at most `TOAST_MAX`, 3; a toast on screen never moves: see `Toaster.tsx`), hover/focus pauses
every timer. A `call` action runs once, then the toast closes; a
failed command becomes an error toast with core's message. Undo toasts: `toast({level:'info', message:'Denied · Undo
(3 s)', durationMs: 3000, action:{label:'Undo', call:{cmd:'asks.undo', req:{runId, requestId}}}})`.

## Streams — `lib/streamBuffer.ts`

Outside React; the bridge feeds it. Per run, per `(step, attempt)`, ordered blocks (`StreamBlock`, keyed by `id`):

| kind    | from                                 | fields                                                                                                                                                                |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`  | consecutive `text` deltas, coalesced | `text` — a block past 2000 chars ends after the next newline, never past 8000; render text blocks as `whitespace-pre-wrap` blocks in order (they continue each other) |
| `tool`  | `tool` start/end merged by id        | `toolId?`, `name`, `summary`, `status: 'running'\|'ok'\|'failed'\|'declined'`, `startedAt`, `endedAt?` (envelope ts, core clock)                                      |
| `ask`   | `ev.type === 'ask'`                  | `requestId`, `askKind`, `detail`, `reason?`, `expiresAt` (updated by `ask-extended`), `allowSession`, `defaultToNo?`, `resolved?: {by, decision?, via?, at}`          |
| `auto`  | `auto-answered` bodies               | `requestId?`, `tool`, `decision`, `why`                                                                                                                               |
| `error` | `ev.type === 'error'`                | `message`, `fatal`, `category?`                                                                                                                                       |
| `done`  | `ev.type === 'done'`                 | `result`, `usage?`                                                                                                                                                    |

```ts
const s = useStream(runId, step, attempt?)   // latest attempt by default; ≤ 1 re-render per animation frame
s.blocks        // last 400 (STREAM_BLOCK_CAP), frozen
s.dropped       // blocks cut from the front ("N earlier blocks hidden")
s.attempt / s.attempts / s.firstOutputAt / s.done / s.version
streamText(runId, step, attempt?)            // full text incl. dropped blocks (tests, E2E)
```

A new attempt (`step-status` with attempt n) gets its empty stream at once, so the view switches before output
arrives (`firstOutputAt === null` → show "claude.exe spawned 1.2 s ago · waiting for first output" from StepView).
Before the spawn, PassCard's launch line names what core says the launch waits on (`StepView.launchWait`, e.g. Plan
waiting for the run-start snapshot reads "Taking the run-start snapshot · Claude starts after it").
Apply StreamPane's `content-visibility:auto` and `role="log"` yourself.

## Routing — `lib/router.ts`

`#/` dashboard · `#/runs` · `#/runs/:id` (tab flow) · `#/runs/:id/:tab` (`RUN_TABS` = flow, diff, log, config) ·
`#/settings[/:section[/…subpath]]` · `?query` on any route · anything else → `notFound`. Easy mode (`pages/easy/`):
`#/easy[/new|projects|settings|existing|overnight]` (`EASY_PAGES`; `existing?folder=` is "Work on something I already
have", `overnight` the overnight list over the factory's queue) and `#/easy/runs/:id` (its milestones, then the Done
screen); with `ui.experience` easy, `#/` goes to `#/easy` (`state/experience.ts` holds core's `easy.state`). All Easy
words are in `pages/easy/text.ts`.

```ts
const route = useRoute() // Route union: dashboard | runs | run{runId, tab} | settings{section?, subpath} | notFound
href({ name: 'run', runId, tab: 'diff' }) // '#/runs/<id>/diff' — use as <a href>; the link helper
navigate({ name: 'settings', section: 'vendors', subpath: ['codex'], query: { field: 'path' } })
navigate('#/runs', { replace: true })
parseHash(hash) / currentHash()
```

## Time — `lib/ticker.ts`

`useNow()` re-renders once a second from one shared interval (only while subscribed); `useNow(false)` returns the
mount time and never ticks (use it for finished runs). Never start your own `setInterval` for a clock.

**Core deadlines — `lib/coreClock.ts`.** An ask's `expiresAt`, `pendingDenyUntil` and `wait_until` are core
times, and under `DIM_FACTORY_E2E_TIME_SCALE` core's clock runs `scale`× faster than the window's. Count down with
`useCoreNow()` / `coreNow(local?)` / `coreRemainingMs(deadline)`, never `Date.now()` (`CountdownRing` already does).
The bridge feeds it: `configureCoreClock(appInfo, e2eSource)` (an optional `AppInfo.timeScale`; under E2E
`e2e.state` gives core's now and scale) and `observeCoreEvents(batch)` at arrival (heartbeats re-anchor beyond a
250 ms tolerance; a live envelope stamped later than predicted moves it forward). `resetCoreClock()` in tests.

## Formatting — `lib/format.ts`

`formatDuration` (`12s`, `4m 12s`, `1h 3m`) · `formatClock` (`2:13`) · `formatEta(p50)` (`~6 min`) ·
`formatDurationRange(p)` (`6–10 min`) · `formatElapsedVsEta(elapsed, eta?)` (`2:13 / ~6 min`, `8:40 · longer than
usual`) · `formatRunEta(progress, now)` / `etaRemainingMs` (a run's ETA as core states it: `ETA ~6 min` counting
down to core's `etaEndsAt`, `longer than usual` from core's `etaState`; never decided here) · `formatAgo` · `formatTokens` (`12.3k`) · `formatUsage(usage)` (`12.3k in · 4.1k out · 80.0k cache`) ·
`formatCost({usd, basis, apiEquivalent?})` (`$0.62`, `$0.62 est.`, `NO_PRICE` = `No price`, `… · API-equiv.`) ·
`costTitle` (tooltip) · `COST_BASIS_LABEL` (vendor `reported by vendor`, catalog `est. from pricing`, none `no price
known`) · `runCostBasis(summary)` /
`formatRunCost(summary)` / `runCostTitle(summary)` (no figure: shared/cost-text.ts `NO_RUN_COST`, the words the dev CLI
prints too: `No cost yet` while nothing is reported, `No cost reported` once ended, `No price` for usage without a price) ·
`formatFiles(files, added?, deleted?)` (`7 files +120 −34`) · `formatFindingCounts`
(`3 must · 5 should`) · `outcomeText(summary)` (the Recent-runs strings: `Fixed · 3 must · 5 should`,
`Clean: no findings`, `Completed with failures`, `Failed at Implement · Codex login expired`, `No changes made`,
`Cancelled at Review`, `Findings open · 2 must · 1 should`; null while running) · `failedAtText` · `cancelledAtText` ·
`stepLabel` / `STEP_LABEL` (core's: Baseline verify, Verify, Final verify for verify:0/1/2) · `PASS_STATUS_LABEL` ·
`RUN_STATUS_LABEL` (`waiting` → `Waiting for you`) · `RUN_PHASE_LABEL` · `PAUSE_REASON_LABEL` ·
`categoryTitle(category, vendor?)` (core's failure category titles; a test keeps them identical) · `vendorName(id)`.
Mode copy comes only from `StepView.modeCopy` (`Support.copy`), so there is no mode label here.

## Keys — `lib/keys.ts`

```ts
useShortcut(KEYS.runOrApprove, approve, { description: 'Approve' })   // mod = ⌘ on macOS, Ctrl elsewhere
useShortcut(KEYS.allowOnce, allow, { scope: 'ask' })                   // single keys need a scope…
<section data-key-scope="ask" tabIndex={-1}>…</section>                  // …and fire only with focus inside it
```

`KEYS`: runOrApprove `mod+enter`, palette `mod+k` (reserved: only `components/palette` binds it, with `reserved: true`), stop `mod+.`,
dashboard/runs/settings `mod+1/2/3` (App binds these), openDiff `mod+shift+d`, allowOnce `a`, allowForRun `shift+a`,
deny `d`, diff `j`/`k`/`r`/`s`, keyboardSheet `?`. Single keys never fire while typing in an input; modifier combos do
(⌘↵ from the plan editor) unless `allowInInputs: false`. A scope stops at `SCOPE_BARRIER` (a menu, a listbox, a
dialog, `data-key-scope-stop` such as the toasts): a letter typed there is never a key of a scope set around it (the
Diff tab sets `diff` on `<body>`). A scoped registration beats a global one; the newest wins.
A held key's auto-repeat (`e.repeat`) fires nothing unless the registration passes `repeat: true`.
`registeredShortcuts()` for the keyboard sheet; `formatCombo` (`⌘↵` / `Ctrl+Enter`), `ariaKeyShortcuts` for
`aria-keyshortcuts`, `<Kbd combo="mod+enter"/>`.

## Line diff — `lib/linediff.ts`

`diffLines(old, new, {context?: 3})` → `{hunks: {oldStart, oldLines, newStart, newLines, lines: {kind: 'context'|'add'|'del',
text, oldNo?, newNo?}[]}[], added, removed, identical}` (Myers; CRLF = LF). `formatUnified(diff)` for copy. Plan gate:
`diffLines(original, edited)` → "Edited · view changes".

## Theme — `lib/theme.ts`

`readInitialTheme()`, `applyTheme(themeState)` (`.dark`, `data-accent`, color-scheme on `<html>`),
`setStreamFontSize(px)` (`--stream-font-size`, config `ui.streamFontSize` 12/13/14; `useStreamFontSize()` /
`currentStreamFontSize()` read the size applied now). Theme changes from main arrive as `theme` events and are applied
by the bridge; Settings calls `ui.setTheme` and waits for that event. The preload's initial theme is the one from window
creation; after a reload main's `theme` push (on `app.ready`) brings it up to date. The stream size is not part of the
theme: `lib/streamFont.ts` `installStreamFontSize()` (main.tsx) reads the user's dimfactory.json (`config.read`) at start
and after every `config-changed`, and Settings → Appearance writes it with `config.patch`. A dark accent applies where
`.dark` and `data-accent` sit on one element (an accent swatch carries both). Contrast: every theme × accent pair is
computed from tokens.css by `tests/renderer/settings/contrast.test.ts` (text 4.5:1, focus ring 3:1).

## UI primitives — `components/ui/`

`Button` (variant default/secondary/outline/ghost/destructive/link; size sm/md/icon; `asChild` for links; `icon` =
the leading icon slot, where `loading` puts its spinner, so a busy button keeps its label AND its width; `kbd` = a
key-hint chip the spinner covers when there is no icon; `loading` with neither slot adds no spinner (disabled +
aria-busy; show the state beside the button); `labels` = every label it can show, widest reserved) ·
`StableLabel({labels, current | children, align?})` (UI control standard: a label whose box
never changes size; the reserved labels are aria-hidden CSS generated content, so `textContent` and the accessible
name are the current label only) · `Badge` (+ status variants), `StatusBadge({kind:'pass'|'run', status, label?})`,
`AutoBadge` (amber `AUTO`), `STATUS_TONE` · `StatusDot({status, label?})` · `Tooltip({content, children, side?})` +
primitives · `DropdownMenu*` · `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` · `Select*` · `Checkbox` ·
`Switch` (`tone="auto"` = amber) · `Input` · `Textarea` (`mono`) · `Separator` · `Kbd` · `Toaster` ·
`CountdownRing({expiresAt, totalMs, size?, showLabel?})` (shared ticker, `role="timer"`; the label reserves
`countdownReserve(totalMs)`, the widest time it can show) ·
`DisabledHint({reason?, children})` (disabled-not-hidden; default reason `LATER_VERSION` = "Available in a later
version"; one focusable `role="group"` named "<control label> <reason>") · `EmptyState({title, description?, icon?, action?})`.

Tokens as Tailwind colours: `bg-background text-foreground bg-card bg-popover bg-muted text-muted-foreground
border-border border-input ring-ring bg-primary text-primary-foreground bg-secondary bg-accent bg-destructive
text-success text-warning text-info`, status `text-st-running bg-st-running/15` (queued, running, waiting, stalled,
paused, done, skipped, failed, cancelled), `text-auto bg-auto/15`, diff `text-diff-add bg-diff-add-bg text-diff-del
bg-diff-del-bg`; `stream-text` utility = monospace at `--stream-font-size`. Dark mode is the `.dark` class (`dark:`
variant). Respect reduced motion with `motion-safe:` / `motion-reduce:`.

## Tests — `tests/renderer/`

`helpers/rtl.ts` (import first in any test that renders: act environment + cleanup), `helpers/mockDimFactory.ts`
(`installMockDimFactory({handlers})` → `{calls, callsOf(cmd), push(...events), on(cmd, h), uninstall()}`; throw
`mockError(code, message)` from a handler for `{ok:false}`; `deferred()` to hold a reply), `helpers/fixtures.ts`
(`makeSummary`, `makeSnapshot`, `env`, `ev`, `text`, `runEvent`, `textLog`), `helpers/readSource.ts`. Reset between
tests with `resetBridgeForTests()`, `resetStore()`, `streamBuffer.reset()`, `clearToasts()`, `cancelRefetches()`.

## Attention — `components/attention/`

`AskCard` (the ask being answered: A/⇧A/D in scope `ask`, Deny with the 3 s grace + Undo, a stale answer reported to
the panel; `armDelayMs` keeps keys and buttons inert for `ASK_ARM_MS` = 500 ms, `data-armed="false"`), `askText.ts` (titles, the assertive announcement, notes for asks answered elsewhere), `StallBody` (the
stall card: `stall-keep-waiting` / `stall-stop`), `AutoApproved` (core's `RunSnapshot.autoAnswered` →
`AUTO approved N`), `KeyboardSheet` (`?`, mounted by App; not a modal). `components/run/AttentionPanel.tsx` composes
them: assertive `ask-announcer` (one `<p data-request-id>` per ask, keyed, so an identical second ask is still a new
node and is announced), a polite `role=status` region for `ask-withdrawn-note` / `ask-stale`, focus to a new ask only
when nothing else has it, and the arming delay for an ask that moved up from the queue (a fresh ask is armed at once). `components/run/AutoSwitch.tsx` is [Switch to Auto ▾] (`runs.switchToAuto`): on the ask card for an Implement or Fix ask outside Auto (`ask-auto-switch`), and in the Run header as [Auto ▾] (`auto-switch`, an icon in the compact header; its room stays hidden once the run ends, `auto-switch-room`). Settings → Notifications is `pages/settings/NotificationsSection.tsx`.

## Command palette — `components/palette/`

`CommandPalette` (mounted by App; ⌘/Ctrl+K, the app's only modal): cmdk in a Radix dialog of one fixed height whose
results are the `data-scroll-region="palette"` region. While open its keys never reach the app's shortcuts. A choice
runs after the dialog has closed and given the focus back (so what it focuses keeps it). `items.ts` builds the groups
from the store: Actions, Needs you (core's attention items → the run, then `focusInRun` on the ask panel or card),
Runs (active first, then recent), Folders (`folders.recent` → `requestComposer({folder})`), Settings (sections, vendor
fields, and every row of `pages/settings/index.ts`). `composerIntent.ts` is how the palette reaches the composer
(`useComposerIntent` in QuickComposer). `followUp.ts` waits for a target after a navigation, reveals it under the header
only when out of view (within `REVEAL_MS`), focuses it, and gives up on the user's next input. `SettingsFieldFocus`
(mounted by App) gives every `#/settings/<section>[/<sub>]?field=<id>` link its row's focus; add a row to the index and
mark it with `<SettingRow field=…>` (see the header of `pages/settings/index.ts`).

## Recovery actions — `components/recovery/`

One component renders core's `RecoveryAction[]` everywhere (snag cards, preflight cards, the composer's preflight
strip, the setup card, Settings → Vendors). Core's order is kept; the first action is the one primary button.

```tsx
<RecoveryActions
  actions={check.recovery}
  runId={runId} // a run's snag / card → recovery.execute{actionId, runId}
  folder={folder} // a composer preflight → recovery.execute{actionId, folder}; neither for probe checks
  step={view.key} // snag only: the pass the older-core retry fallback needs
  onRecheck={rerun} // after "I ran it → Re-check" re-probed the vendor: re-run your preflight
  layout="commands" // 'buttons' (default) | 'commands': each shell command on a line with [Copy] ("Copy: <label>")
  check={check} // drops a command's reason when it repeats the check's title/detail
/>
```

- Every action runs `recovery.execute`. `shell_copy`: main copies → toast "Copied. Run it in a terminal." ("…in an
  administrator terminal." when `elevated`) → the same button now reads **I ran it → Re-check** (its testid becomes
  `recheck-<actionId>`; every label is reserved and the icon slot cycles Copy → RotateCw → spinner), which
  runs `vendors.probe {vendor, force: true}` for the vendor of the action's `recheck` check id
  (`vendor.claude.auth` → claude), stores the views, toasts `<Vendor>: <healthDetail>`, then calls `onRecheck`.
  `settings_link` navigates to core's route; `open_docs` toasts "Opened in your browser"; retry / skip_pass /
  close_run / resume go through recovery.execute too (then the run's snapshot is refetched).
- Executors with their own controls (`ConfigPatchControl.tsx`, `WaitUntilControl.tsx`, `HealDiagnosis.tsx`, `heal.ts`):
  - `config_patch`: one block per fix (same `target` + `ops`) with its change previewed (core's `preview`, else one
    line per op; diff colours, in the page flow) and **Apply to this run** (Apply to the next run in the composer)
    plus **Apply and save to project|user** when core offers the same ops again with `persist`. Core checks the
    allowlist and writes the file; `RecoveryResult.persisted` gives the toast its Undo (`config.restoreBackup`, or
    removing the keys from a file core created). A composer fix answers `overrides`, handed to `onOverrides`.
  - `wait_until`: a countdown on core's clock (`lib/coreClock.ts`, reserved width) with **Arm / Re-arm / Disarm**
    (one width; executing the action toggles it, `RecoveryResult.wait` is the new state) and **Retry now**
    (`runs.retryPass`). Pass `wait` (StepView.wait): core's state wins, so a wait loads disarmed after a relaunch.
  - `grant`: a button with what it trusts under the row (`detail`, a command grant's argv); outside a run a
    successful grant calls `onRecheck`. `switch_vendor`: disabled until its vendor is ready (no probe or a stub:
    "Available in a later version"; built: "<Vendor> is not ready: <health>"). `heal` outside a run shows
    `RecoveryResult.heal` under the row.
  - Disabled with the reason: core's `disabledReason` first, then a kind in `LATER_KINDS` (none today; the
    `vendorFolder` grant runs too) (`laterReason`). Props `handlers` (actions the caller runs itself, by id) and
    `pendingIds` (shown busy) serve the snag card's diagnosis request and its Close run fallback.
- Errors are toasts with core's message.
- When core answers UNSUPPORTED (an older core), the direct calls stand in: `runs.retryPass` / `runs.skipPass` /
  `runs.close` / `runs.resume`, the renderer clipboard, `shell.open`; any other kind then renders disabled with
  "Available in a later version". `shell_copy` / `settings_link` / `open_docs` also fall back on NOT_FOUND (core has no
  record of the action; none of them changes anything).
- A `settings_link` is resolved (one `recovery.execute`, which only computes a route in core) when first shown
  while it is unknown whether this build's core executes it; the button is disabled until then, then navigates
  straight to the resolved route. Expect that call in tests that render one (`resetRecoveryForTests()` between tests).
- Test ids: `recovery-<actionId>` (+ `data-kind`; a config fix's save button too), `recheck-<actionId>`,
  `patch-<firstActionId>` / `patch-preview-…`, `wait-<id>` / `wait-status-<id>` / `wait-retry-<id>`,
  `grant-note-<id>`, `recovery-heal`. `components/run/RecoveryActions.tsx` re-exports the same component.
- **Snag card** (`components/run/SnagCard.tsx`): title, core's message, the AI diagnosis (`StepView.heal` through
  `HealDiagnosis`: on its way, "Diagnosis (AI, medium confidence): …", reused, failed with the raw error, turned off
  with a link to Settings → Self-heal, "Dim Factory hid N unsafe suggestions"), core's buttons in its order with **Ask AI
  to diagnose** (core's heal action, else `heal.diagnose`, failed passes only: core does not diagnose runner steps)
  primary only where core lists it first (e.g. `unknown`, flag_drift's "Find the renamed flag") and only
  before a diagnosis, Close run last in that row while the run is failed, then the AI's fixes ("Suggested by AI", the
  first one primary), the raw error. Nothing moves on its own: once shown, every button keeps its place; an answer only
  changes variants (`RecoveryActions` `primaryId`) and adds the AI's fixes after the row. A
  request is remembered per step until core's answer shows (`useHealRequest`, `resetHealForTests()`). Test ids:
  `snag-<step>`, `snag-heal-<step>` (+ `-text`, `-error`, `-hidden`, `-applied`, `-settings`),
  `snag-suggestions-<step>`.
- **Settings → Self-heal** (`pages/settings/SelfHealSection.tsx`): `selfHeal.*` through `config.patch` (user scope,
  Undo), vendors from the probes (built ones), models from `vendors.models`, and the last 10 diagnoses from run state
  (`collectHeals`; the 20 newest runs are loaded once the section opens). Test ids `selfheal-*`.
- **Settings data**: `pages/settings/sectionData.ts` `useSectionData(key, load, version)` reads a section's data
  once it has been open `SECTION_LOAD_DELAY_MS` (performance.spec.ts: a switch costs no IPC), keeps the last answer while `version`
  (the config epoch) reloads it; `useLinkFocus(match, find, ready)` for a section's own deep-link targets (core's
  pointers that are not index rows); `formatBytes`. Content whose length is unknown until core answers goes last in its
  section, so nothing shown moves when it arrives.
- **Settings → Diagnostics / Config file / Catalog / Isolation & Verify**: `DiagnosticsSection.tsx` (AppInfo
  versions and paths; `storage.usage` sizes and per-folder snapshots; Clear snapshots is the one inline two-step
  confirm, disabled with the reason while a run in the folder has not ended; `diagnostics.copy/save` with raw lines
  opt-in and `diagnostics.build`'s redaction counts), `ConfigFileSection.tsx` (`config.read` of the user file or a
  chosen project's, numbered read-only lines with each problem marked and listed as file:line:col; Restore last good
  through `config.restoreBackup('last-good')` with Undo; `shell.open {target:'configFile'}`), `CatalogSection.tsx`
  (see "Catalog" below), `IsolationSection.tsx` (the
  Verify half, see "Verify" below; the Isolation half, see "Isolated runs").

## Branch, reconcile and revert

- Cards: `components/cards/ReconcileBody.tsx` (core's reasons with their `actions` through RecoveryActions, plain
  commands through `recovery/CopyCommands.tsx`, the paths via `PathList`, choices with `defaultChoice` as the primary)
  and `PlanMutatedBody.tsx`. Payload readers: `reconcileOf`, `planChangedPaths`, `choicesWithDefault` (`payload.ts`).
  A choice core answers UNSUPPORTED for is remembered and shown disabled (`resolve.ts` `useLaterChoice`;
  `resetLaterChoicesForTests()`).
- Revert all: `components/run/revert.ts` (`revertAll`, `undoRevert`, `folderBusyReason` from core's summaries,
  `useRevertUndoToast` for `RunSnapshot.revertUndo`; `resetRevertForTests()`) and `RevertAllButton` (`revert-all`,
  `diff-revert-all`); the Stop toast uses it with `liveDisabledReason`. `folderBusyReason`: a run works in the folder
  while it is running, waits on an ask (the open run's `asks`; from a summary alone, any waiting step), or has ended
  but still holds its lock (its last snapshot); a gate or a card holds no process, so a revert is allowed there.
- A card revert's Undo (`RunSnapshot.revertUndo`, whose `label` reads after "Reverted"): the toast's Undo waits while
  the run works (`liveDisabledReason`), and "After the run" keeps it (`run-end-revert-undo`, `run-end-undo`).
- Run branch: `components/run/branch.ts` (`branchLineText`, `runs.branch` answers kept per run;
  `resetBranchOutcomesForTests()`); the header's line is `run-branch`; "After the run" (`RunEndPanel`, `run-end`) holds
  Revert all and `branch-return` / `branch-delete` with core's reason and commands when it cannot act.

## Verify

- Run view: `components/run/VerifyCard.tsx` is a verify round's card in the flow (FlowTab gives every `verify:<n>`
  step one; same `pass-card-<step>` id and test id, `data-kind="verify"`). Rows come from core's
  `StepView.verify.commands` (`VerifyModel.ts` reads it defensively and words it: `VERIFY_STATUS_LABEL`,
  `verifySummaryText`, `verifyFactsText`); the line under the header (never wraps) has the time and the summary. A
  failing or env command's excerpt is an inner region (`data-scroll-region="verify-output"`); a command Auto skipped
  as untrusted links to Settings (`verifySettingsHref(folder)`). `VerifyOutput.tsx` reads the round's output file
  `verify:<n>` when core announces a new version with an `output` body (at most every `READ_EVERY_MS`, the newest
  `VERIFY_OUTPUT_TAIL` characters) and follows it while pinned (`useFollowBottom`, Jump to latest); a core that
  streams the round as step events is shown through StreamPane instead. A round the view watched keeps its live
  layout (output first, excerpts open on a click, and core's reason on a line that is always there, so "trust needed"
  coming and going moves nothing); one over when the card mounts shows its rows first with the first failure's excerpt
  open (the others on a click: two inner regions stacked would leave the wheel no page) and its output in a
  disclosure read only when opened. The timeline marks a finished round with a failing command (border) and names its
  results in the node's tooltip. FlowTab puts a card for a step on the page into that step's block only while the
  block ends the flow; a card that opens once something came after it (a note core added mid-round, before the
  round's verifyEnv card) gets its own place at the end, decided once per card (`useCardPlaces`).
- Cards: `cards/TrustBody.tsx` (command, where it runs, the script or what changed in it: core's `diff`, else
  `scriptDiff`; `BodyDiff` is shared with Settings) and `cards/VerifyEnvBody.tsx` (each command the environment could
  not run with core's reason or exit code and its excerpt; core's choices, Retry its primary). Payload readers
  `trustOf`, `verifyEnvOf`, `paragraphs`; choice ids `TRUST_CHOICE`, `VERIFY_ENV_CHOICE` (a test keeps them equal to
  core's). The gate before Fix marks a verify finding with a Verify chip and a pre-existing failure with "Already
  failing before this run".
- Composer: Verify is the run override `verify.enabled` (`overrides.ts setVerifyEnabled`) with core's provenance
  badge; the label counts the resolved commands less those turned off (`model.ts verifyCommandCount`); "Choose
  commands" opens Settings → Isolation & Verify for the folder; the tooltip carries core's `run.verify` check.
- Settings → Isolation & Verify (`pages/settings/IsolationSection.tsx`, `verify/*`): live; the Isolation half and the
  baseline check are described below. Defaults write `/verify/{enabled,runAfter,failFast}` with config.patch and Undo,
  to the chosen project (`?folder=`) or your settings. The command table joins core's resolved `verify.commands`
  and `verify.detect` (`verify/model.ts verifyRows`); turning a command on or off, removing one, "Use the detected
  commands" and adding one replace `/verify/commands` in one patch. Trust / Untrust call `trust.set` with the hash
  core showed (CONFLICT when the script changed since), with Undo. The command editor (`verify/argv.ts`) is a port of
  core's tokenizer with core's words; `tests/renderer/verify/argv.test.ts` runs one corpus through both.

## Isolated runs

- Readers and words: `components/run/isolation.ts` checks what core sends about an isolated run, since every field is
  optional on the wire: `prepareRowsOf` (StepView.prepare.steps), `finalizeInfoOf` / `finalizeStateText`
  (StepView.finalize), `isolatedNotApplied` (RunSummary.worktree.notApplied), the card payloads (`depsOf`,
  `conflictsOf`, `conflictChoices`, `interruptedOf`), and for the composer `isolationIneligible` (core's folder.git and
  run.isolation.worktree words) and `uncommittedCount` (a live check that says "N uncommitted changes").
- Run view: `PrepareCard.tsx` (`data-kind="prepare"`): core's five rows from the run's start, each one fixed line for
  core's detail; the install output (runs.output `prepare`, else the step's stream) in an inner region
  (`data-scroll-region="prepare-output"`) with its full height from the start when core's rows say an install runs,
  following only while pinned. `FinalizeCard.tsx` (`data-kind="finalize"`): one line of core's state with [Undo] while
  core holds a token; an apply or a discard core reports while the view is open gets its Undo toast once per token
  (`worktree.ts` `undoApply` / `undoDiscard`, the Discard toast lasting until core's `deleteAt`). In `steps.ts`,
  `isPlannedIsolatedStep`: Prepare and Finalize (and verify:0 when core lists the baseline) show from the start.
  "After the run" says where an isolated run's changes are and links to the Diff tab's Apply panel.
- Cards: `DepsBody.tsx` (depsConsent / depsFailed: command, where, source, what went wrong with the excerpt; [Edit
  command] opens an editor that refuses shell syntax, `pages/settings/isolation/installCommand.ts`),
  `FinalizeBody.tsx`, `ConflictsBody.tsx` (a [Keep mine] / [Take run's] pair per file sending that path as the choice's
  `paths` input, the card's row for every file; the run's change via `diff.file` on a click), and
  `InterruptedApplyBody.tsx`. Choice ids `DEPS_CHOICE`, `FINALIZE_CHOICE`, `CONFLICT_CHOICE`,
  `INTERRUPTED_APPLY_CHOICE` (`payload.ts`; a test keeps them equal to core's).
- Diff tab: `components/diff/ApplyPanel.tsx` counts core's `worktree.preview` for all files or the reviewed ones in one
  reserved line (the reviewed count is core's `reviewed`: marks naming the version Apply writes), applies with
  `worktree.apply` (`reviewedOnly` for "reviewed only") and its Undo toast, lists conflicts on a click, says why Apply
  is disabled, and offers [Discard copy] (`worktree.discard`, deferred 10 s, Undo in its toast; `worktree.ts`
  `discardCopy`). An isolated run's Revert all and per-file Revert are disabled with `ISOLATED_REVERT_REASON` (they
  would change the copy, never the folder). `useWorktreeSupported` remembers a core that answers UNSUPPORTED. The Stop
  toast of an isolated run follows core's finalize state: "some of its changes are in your folder" [Undo the apply]
  once part of it was applied.
- Composer: Isolated run is the run override `isolation.mode = worktree`; disabled with core's reasons; once chosen a
  line says "N uncommitted changes not included" (or that the run starts from the last commit).
- Settings → Isolation & Verify: `pages/settings/isolation/IsolationGroup.tsx` (run location, a new branch, the copy
  list as one line until its editor opens, install policy, install command, autoApply) and the Verify baseline switch,
  each one config.patch with Undo. Dashboard: `pages/dashboard/IsolatedChip.tsx` ("Isolated: not applied").

## History and re-run

- Runs page (`pages/runs/`): `RunsPage.tsx` (the tiles, the filters, the list), `filters.ts` (`RunFilters` →
  runs.list's query with `listQuery`: status, folder, vendor, date presets or a custom range as `from`/`to`, and the
  title text sent once typing pauses, `TEXT_DEBOUNCE_MS`, or on Enter; Load more reuses the first page's query),
  `StatsTiles.tsx` (`stats.get{range}` for 24 hours / 7 days / 30 days; four tiles of three lines that keep their size,
  "Loading…" / "Not available" / "None yet" in a figure's place), `RunRow.tsx` (outcome, folder, age, duration, cost,
  "Re-run from Fix of #N" from core's `RunSummary.rerunOf`, the AUTO and isolated chips; Pin with `aria-pressed`,
  Remove disabled with the reason for a pinned, live or lock-holding run; the ⋯ menu with Open, Re-run with same
  config, Re-run from Fix, Open diff, Reveal folder) and `removals.ts` (runs.remove → the row stays in place as
  "Removed … [Undo]", plus an Undo toast; runs.undoRemove from either; a refused Undo leaves the row saying why).
  The list holds the runs core listed for the user's filters: live summaries update rows in place, a new run is never
  inserted and a status change never drops a row. Test ids `runs-row-<id>` (`data-removed`), `runs-menu-<id>`,
  `runs-action-{open,rerun,rerun-fix,diff,reveal}`, `runs-pin-<id>`, `runs-remove-<id>`, `runs-undo-<id>`,
  `runs-filter-{status id,folder,vendor,date,from,to,text,clear}`, `runs-stat-<tile>[-value|-sub]`.
- Re-run (`components/run/rerun.ts`): `rerunStart` / `rerunFix` (runs.rerun, then the new run's view; refusals are
  toasts with core's words), `readRerunFromFix` (core's `rerunFromFix`: `unavailable` as the reason, `findingIds` as
  the picker's default ticks), `rerunFromFixText` / `rerunFromFixWhy` (the session line's words and its Why),
  `rerunStartReason` (R14: completed, cancelled, failed, paused), `stopsSourceFirst` (a source still holding its
  folder is stopped when the new run starts, for either form: `rerunStartHint` says so under Re-run with same config,
  `rerun-start-hint` / `runs-action-rerun-text`, as the picker does). The Run view's picker is open per run (`openFixPicker` reads
  the findings first, then the picker arrives whole at the end of the Flow tab and takes the focus; `useFixPicker`,
  `closeFixPicker`, `resetFixPickersForTests()`). `loadFindings` (every picker, the Runs row's too) takes core's list
  from the run's snapshot (`RunSnapshot.rerunFromFix.findings`, also there when the run's Review/Critic join never
  ran and it has no findings.json), else findings.json (runs.output) from a core that does not send it.
- `components/run/FixPicker.tsx`: the inline findings picker (never a dialog): `FindingRow`s from the gate before
  Fix, must first, core's default ticks (else all), "Fix will receive N must · M should", [Re-run from Fix with N
  findings] reserving its widest count, [Cancel]. Used by the Run view (`RunFixPicker`) and under a Runs row.
- Entry points: the header's Re-run ▾ (`rerun-start`, `rerun-from-fix` with `rerun-from-fix-why`; the tooltip says
  fresh and why, or why not), "After the run" (`run-end-rerun-start`, `run-end-rerun-fix`), and the Stop toast's
  second action (offered from core's `RunSummary.rerunFromFix`, which comes with the cancelled status the toast waits
  for; the snapshot is refetched later). Toasts take an optional `secondary` action (`state/toasts.ts`), shown with the first under the
  message (`data-toast-action="primary|secondary"`).

## Catalog

- State (`state/catalog.ts`, the store's `catalog` slice): `loadCatalog()` (catalog.get; overlapping calls share one
  request and one more read follows), `setCatalogState`, `noteCatalogStatus` (dashboard.get's status, from
  `rail/dashboardData.ts`), `onCatalogEvent` (the bridge: `due` marks the status due and reads the catalog; a job's
  start and end read it whole; its progress is taken as it comes; `applied` bumps `epoch`), and the commands, each
  with core's message as an error toast: `startRefresh()` (the only sender of `catalog.refresh`, always
  `{consent: true}`, called only from Update now's click), `cancelRefresh(jobId)`, `applyCatalogRows(jobId, rowIds)`
  ("Prices updated" with Undo), `saveCatalogPrice(entry)` ("Price saved for <model>" with Undo), `undoCatalog()`,
  `setCatalogSchedule(update, said, undo?)` (then reads the catalog, so whether a refresh is due is core's answer).
  Apply, Undo and a price edit bump `epoch`: the composer's live checks (`useLiveChecks` `catalogEpoch`) and every
  model list (`useVendorModels`, Settings' DefaultModel and Self-heal) ask core again at once. `resetCatalogForTests()`.
- Dashboard: `rail/CatalogCard.tsx` is the rail's last item (`RightRail`), so its coming and going move nothing. Its
  mode is core's (`catalogCardMode`): `running` (the job's line with elapsed time on core's clock, core's progress,
  Cancel), `review` (changes found, a link to `#/settings/catalog?field=review`, Not now sets the card aside for the session:
  core keeps the changes until applied or replaced; the running card's two lines and button row, so a job that ends on
  its own keeps the card's height), `consent` (refresh due: core's plan
  names the vendor and model, "read-only, web search, cannot change files", `~time · ≈cost`; Update now, Not now
  (7 days) = `setSchedule {snoozeDays: 7}`, Turn off = `{enabled: false}` with Undo; a fallback note and a failed
  job's reason after the buttons), and `failed` for a job the card showed running in this session (the
  running card's layout: "The price update failed: …", the consent line, Try again (`startRefresh`) and Close, kept
  until the user closes it, so a failure never shrinks the card on its own). It reads the catalog once when core's status reports a job or a due refresh the
  window has not seen. The Settings dot (`useCatalogDue`) follows the slice's status, else the Dashboard's answer.
- Settings → Catalog (`pages/settings/CatalogSection.tsx`, `catalog/*`): `RefreshGroup.tsx` (fixed controls: the
  presets Off/7/14/30 through `catalog.setSchedule` with Undo; the vendor and model as `config.patch` writes of
  `/catalog/refresh/{vendor,model}` with Undo, Codex listed disabled as "Available in a later version" and the model
  list from vendors.models through `lib/modelOptions.ts`; Update now with the consent words, disabled with the reason
  while a job runs; one reserved status line and one reserved note line). Then, once catalog.get answers, all at
  once: `DiffReview.tsx` `ReviewBlock` (while a job runs, or after it ended while watched: one reserved height,
  `REVIEW_RESERVED_CLASS`, until the user acts; changes that arrive while the section is open wait behind Show
  changes; changes there when the section opened show at once) and `DiffTable` (rows in the order first shown,
  `useFrozenOrder`, keeping the user's ticks over later copies; core's flags as `FlagChip`s with their meaning in the
  tooltip and core's `reason` under them; core's default ticks; rejected proposals and unconfirmed models listed,
  never tickable; Apply N changes reserving its widest label, Not now; `confirm` rows read "Confirm
  prices", Unchanged → Verified, and the `notFetched` chip "Page not read"), `PriceTables.tsx` (Edit opens one row's
  four prices as boxes: `parsePriceInput` refuses what the validator would, $0 included, in place with why; Enter
  saves, Escape puts it back; "Edited by you" marks `confidence: 'user'`; Add a price), the Models table, and
  `HistoryTable.tsx` (the last
  20 changes newest first; Undo only on core's `undoId`, else the newest not undone). Words and checks are in
  `catalog/model.ts` (flags, kinds, prices, schedule, history) and `catalog/consent.ts` (consent, plan and job lines,
  `useRefreshPlan`).
- Test ids: the card `catalog-card` (`data-mode`) and `catalog-card-<part>` (consent, estimate, update, snooze, off,
  cancel, status, progress, detail, review, note, failed); the refresh controls `catalog-<part>` (schedule, refresh-vendor,
  refresh-model, consent, estimate, update, refresh-status, refresh-note, review-open); the review `catalog-review`
  (`data-state`) and `catalog-review-<part>` (reserved, line, cancel, show, close); the table `catalog-diff`, its rows
  `catalog-diff-row-<rowId>` with `catalog-diff-tick-<rowId>`, `catalog-diff-delta-<rowId>` and
  `catalog-diff-reason-<rowId>`, `catalog-diff-rejected-<i>`, and `catalog-diff-<part>` (apply, status, close,
  unverifiable); prices `catalog-price-<vendor>-<model>`, `catalog-edit-<vendor>-<model>` (and `-<field>` for a box),
  `catalog-save-<vendor>-<model>`, `catalog-edited-<vendor>-<model>`, `catalog-add-<part>` (price, form, vendor,
  model, a field, save, error); the history `catalog-history`, `catalog-history-<id>` and `catalog-history-undo`.
- Pickers: `lib/modelOptions.ts` `pickerOptions` (the CLI's models first, then the catalog's, each id once, a typed
  value kept) and `modelOptionText` (`· no pricing`, `· deprecated` from core's facts). The composer's datalist uses the
  order; the "no pricing" chip is unchanged.
- Cost labels: `lib/pricing.ts` (`usePricingFacts` from the slice's status; `pricingTitle`: "est. from pricing fetched
  <date> (verified/unverified)", plus the stale note). `costTitle` / `runCostTitle` take it as `catalogBasis`. The
  composer's estimate line (amber and `data-stale-prices` while core says prices are stale, the pricing in its table),
  an active run's card footer, the Run header's cost and a pass's cost while the run goes on; a finished run's cost was
  frozen with the prices of its own day and keeps the plain words. A catalog-priced figure carries core's
  facts of the prices it was priced at (`StepCost.pricing`, the run's own pricingRef); `costPricingFacts` and
  `runPricingFacts` label a pass and the Run header from those, live or finished, and today's catalog only labels a
  figure without them. Settings → Catalog's prices status is two fixed-height rows (`catalog-status`, the stale note in
  `catalog-status-stale`).

## Gemini and folder trust

- Folder trust (`components/recovery/folderTrust.ts`, `FolderTrustChip.tsx`; `state/trust.ts`): Gemini works only in a
  folder the user trusted for it (core's `needsFolderTrust`, src/shared/vendors.ts; the readiness check `trust`, and
  trust.json `vendorFolder`). A grant runs only on a click: `recovery.execute {actionId, folder}` for core's `grant`
  action (`grant: 'vendorFolder'`) when a check offered one, else `trust.set` (a vendorFolder grant for the vendor,
  `trusted: true`) for the composer's folder; the toast (core's words, else "Gemini trusted in <folder>") offers
  Undo, a revoke through `trust.set` with `trusted: false`. Every grant or revoke made here bumps the trust epoch
  (`useTrustEpoch`, `bumpTrustEpoch`): the composer's live checks (`useLiveChecks` `trustEpoch`), the setup card's
  chip and Settings → Vendors ask again. One grant per vendor and folder at a time (`useTrustRun`,
  `resetFolderTrustForTests()`); `resetTrustStateForTests()` forgets the epoch and the composer's folder.
- The chip: a status line of one height (`<id>-status`: "Gemini is not trusted in this folder yet", "Trusting this
  folder for Gemini…", "Gemini trusted in this folder", "Could not trust this folder: …"; the setup card names the
  folder by its path), what trusting means in plain words (`<id>-means`: "If you trust it, Gemini may read and act in
  this folder without its own trust prompt. …"), and [Trust this folder for Gemini] (`<id>`, `data-kind="grant"`, one
  label, a spinner in its icon slot). `<id>-chip` carries `data-phase` (`no-folder`, `checking`, `needed`, `running`,
  `trusted`, `failed`) and `data-vendor`, and keeps the tallest height it reached. Before core's trust.get answered
  (setup card) the chip is its status line alone.
- Composer strip: a check offering a vendorFolder grant (Gemini's `pass.<p>.readiness.trust`) shows the chip as its fix
  (`preflight-trust-<checkId>`), once per strip and vendor (a later chip: `preflight-trust-elsewhere-<checkId>`); an
  open chip lists it before the other fixes. A grant re-runs the live checks and the block clears (gemini-trust.spec.ts).
  The composer publishes the folder it checks (`setComposerFolder`) for the setup card.
- Setup card: Gemini is optional, so it has a row only once its probe found it on this computer (`listsOptionalVendor`:
  ready with its version, login needed with `gemini`, update needed); not installed, or while its first probe runs, it
  has none (no red install block for a vendor nobody has to install, and no row growing the card when
  its launch probe answers after the first-launch ones; Settings → Vendors and "More" still give the install command).
  Once Gemini's probe found it (`offersFolderTrust`), the card holds the chip for the composer's folder
  (`setup-gemini-trust`), read with trust.get. Both are decided with the card, once per visit, from the
  probes in when it shows: a probe that answers later (Gemini's launch probe lands seconds after the card showed) adds
  no row and no chip to this visit, so nothing below moves on its own; the next visit lists it.
- Pass rows: the summary line has the Critic swap chip's height (`min-h-6`, pending and loaded), so the
  chip that comes with a vendor's probe grows nothing below it.
- Right rail: the rail waits, invisible, for state.json (whether the setup card shows), for dashboard.get
  at most `RAIL_WAIT_MS`, and, while the card may show, for Claude's and Codex's first probe answers
  (`primaryProbePending`; no vendor view yet counts as pending), never longer than `RAIL_PROBE_WAIT_MS` (10 s, the
  time the setup card's probes are expected within); then it appears whole and stays. Only the showing waits: whether the setup card shows is
  decided when state.json and dashboard.get answered (or `RAIL_WAIT_MS` passed), so a first launch whose
  probes then answer ready still shows the card with the profile it chose (first-launch.spec.ts). A "Checking Codex…" row used to grow to Codex's install fixes
  seconds after the rail showed (ui-layout.spec.ts "the Dashboard as it loaded", CLS 0.03). The sidebar footer's vendor dots
  hold their height (`min-h-5`) before vendors.list answers.
- Pass rows: "More" lists a built vendor once its `--version` answered (`versionFound`), also when a version check
  failed (Gemini without `--acp` reads "Update needed"); picking one runs `vendors.probe {vendor}` with the choice
  reading "Checking…" until core answers (`composer/probePick.ts`). Models, mode notes and mode copy are core's, as for
  every vendor. An Experimental vendor (core's `ProbeView.experimental`: Muse) reads "Experimental" in both pass
  vendor pickers, before any state note ("Experimental · Login needed"; `EXPERIMENTAL_NOTE`), as Settings → Vendors
  shows its badge. Both pickers' triggers carry the chosen vendor's whole choice as their title (`vendorChoiceText`):
  a long one ("Muse · Experimental · Muse's event shapes are not pinned yet") is cut there (ui-layout.spec.ts's ellipsis
  guard). The setup card never lists an Experimental vendor and never offers its
  folder trust chip (`listsOptionalVendor`, `offersFolderTrust`): Dim Factory does not suggest Muse; once the user picks
  it, the composer's strip offers the grant.
- Settings → Vendors: Gemini's card is every vendor's (path with "Runs with your system Node.js: <node> <entry>" for an
  npm shim, versions, modes, checks with fixes, default model, Test), plus "Trusted folders" last
  (`vendors/TrustedFolders.tsx`, `vendor-trusted-<v>`, rows `vendor-trusted-<v>-row`, Revoke
  `vendor-trusted-<v>-revoke-<folderKey>`): the folders Dim Factory knows of (`folders.recent`, the composer's folder and
  its last one) asked with trust.get, one row per scope root, newest grant first; read after
  `SECTION_LOAD_DELAY_MS` (performance.spec.ts).
- Asks: an ACP ask with `allowSession: false` (no allow_always option Dim Factory accepts) hides "Allow for this run" with
  its note, as for every vendor (gemini-no-allow-session.spec.ts). Tests: `tests/renderer/gemini/`.
- Shell: a "More" vendor that is not installed (Gemini before the user installs it) lights no Settings dot
  (`vendorNotReady`, components/shell/VendorHealth.tsx); its footer dot and rail row still read "Not installed". Once
  installed, a login, update or other failure lights the dot like Claude's or Codex's.
