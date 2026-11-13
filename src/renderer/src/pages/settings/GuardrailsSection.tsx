// Settings → Guardrails: the rules a run must keep, your own file's (`guardrails`). A project can add to them and never
// take one away. Every rule states what it stops and what it cannot stop, because a rule you trust further than it holds
// is worse than no rule. Test this rule runs the same code as the real checks and costs nothing; Prove it spends a few
// tokens on a real Claude session, only on a click. Loosening a rule here is recorded, and the section says when.
// Nothing is read until the section has been open for LOAD_DELAY_MS, so a section switch renders at once and passing
// through costs no IPC.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type {
  GuardrailPreset,
  GuardrailProof,
  GuardrailRule,
  GuardrailSuggestion,
  GuardrailsState,
  ProveKind,
  RuleTestResult,
} from '@shared/guardrails.ts'
import {
  GUARDRAIL_INFO,
  PROVE_KINDS,
  SELF_PROTECTED_PATHS,
  describeRule,
  proofNeedsRetest,
  onBreakOf,
  presetRules,
  ruleKey,
  rulesInForce,
  testRules,
} from '@shared/guardrails.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { invoke } from '../../ipc/client.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { Group, SettingRow } from './kit.tsx'

type Settings = ResolvedConfig['guardrails']

const LOAD_DELAY_MS = 150
const UNDO_TOAST = 'guardrails-undo'

const PRESET_TEXT: Readonly<Record<GuardrailPreset, { label: string; about: string }>> = {
  off: { label: 'Off', about: 'Only your own rules below, plus settings files.' },
  recommended: {
    label: 'Recommended',
    about: 'No publishing or git push, tests may not be weakened. Normal work is not slowed.',
  },
  strict: {
    label: 'Strict',
    about: 'Recommended, plus an Isolated copy, no Approve everything, and new dependencies need approval.',
  },
}

export const STRENGTH_TEXT: Readonly<Record<string, string>> = {
  hard: 'Refused before the run starts',
  sandboxed: "Refused by the AI tool's sandbox",
  blocked: 'Stopped before it runs',
  caught: 'Found afterwards',
  none: 'Cannot be kept',
}

export const dateText = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const PROOF_RESULT: Readonly<Record<GuardrailProof['result'], string>> = {
  held: 'Held',
  broken: 'Broken',
  unclear: 'Not shown either way',
}

/** A rule's last proof in words, with the re-test it needs after a CLI update. */
export function proofText(proof: GuardrailProof | undefined, version: string | null): string {
  if (proof === undefined) return 'Not proven yet.'
  const on = `on ${dateText(proof.at)}, Claude ${proof.version ?? 'version unknown'}`
  if (proofNeedsRetest(proof, version))
    return `Needs a re-test: ${PROOF_RESULT[proof.result].toLowerCase()} ${on}, and Claude is ${version ?? ''} now.`
  return `${PROOF_RESULT[proof.result]} ${on}. ${proof.detail}`
}

/** The rules with nothing to fill in: one button each. */
const ONE_OF_A_KIND: readonly { rule: GuardrailRule; label: string }[] = [
  { rule: { kind: 'noWritesOutside' }, label: 'No writes outside the folder' },
  { rule: { kind: 'network', allow: false }, label: 'No network' },
]

export const NOT_A_BOUNDARY =
  'Guardrails are not a security boundary against deliberately malicious code. Found afterwards cannot undo a network call, a read, or anything outside the folder.'

function RuleRow({
  rule,
  onRemove,
  label,
}: {
  rule: GuardrailRule
  onRemove?: () => void
  /** Stands in for the rule's own line when one row covers several like it. */
  label?: string
}): React.JSX.Element {
  const info = GUARDRAIL_INFO[rule.kind]
  return (
    <div className="flex flex-col gap-1 border-b py-2 last:border-b-0" data-testid="guardrail-rule">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-sm break-words">{label ?? describeRule(rule)}</span>
        {onRemove !== undefined && (
          <Button variant="outline" size="sm" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {info.byVendor === undefined ? `${STRENGTH_TEXT[info.strength] ?? ''}. ` : ''}Stops: {info.stops}
      </span>
      <span className="text-xs text-muted-foreground">Cannot stop: {info.limit}</span>
      {info.defaultOnBreak !== undefined && (
        <span className="text-xs text-muted-foreground">When it fires: {onBreakOf(rule)}</span>
      )}
    </div>
  )
}

/**
 * Rules worth having for one project, each with its reason, from what is in its folder. Accepting one writes it to that
 * project's file, where it joins your rules.
 */
function ProjectSuggestions(): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(null)
  const [list, setList] = useState<GuardrailSuggestion[] | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (folder === null) return
    let alive = true
    void Promise.all([invoke('guardrails.suggest', { folder }), invoke('config.resolve', { folder })]).then(
      ([s, c]) => {
        if (!alive) return
        if (!s.ok) {
          toast({ level: 'error', message: s.error.message })
          return
        }
        const have = c.ok ? new Set(c.value.config.guardrails.rules.map(ruleKey)) : new Set<string>()
        setList(s.value.filter((x) => !have.has(ruleKey(x.rule))))
      },
    )
    return () => {
      alive = false
    }
  }, [folder, nonce])
  const accept = async (rule: GuardrailRule): Promise<void> => {
    if (folder === null) return
    const c = await invoke('config.resolve', { folder })
    if (!c.ok) return
    const rules = [...c.value.config.guardrails.rules, rule]
    const r = await invoke('config.patch', {
      scope: 'project',
      folder,
      ops: [{ op: 'replace', path: '/guardrails/rules', value: rules }],
    })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    else toast({ id: UNDO_TOAST, level: 'info', message: 'Rule added to this project.' })
    setNonce((n) => n + 1)
  }
  return (
    <Group
      title="For a project"
      description="Rules worth having, from the names in its folder. Nothing is applied until you accept it."
      testId="guardrail-suggestions"
    >
      <ProjectFolder folder={folder} onChange={setFolder} testId="guardrail-project" />
      {list !== null && list.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing to suggest.</p>
      )}
      {list?.map((s) => (
        <SettingRow key={ruleKey(s.rule)} label={describeRule(s.rule)} description={s.reason}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void accept(s.rule)
            }}
          >
            Accept
          </Button>
        </SettingRow>
      ))}
    </Group>
  )
}

/**
 * Prove it: one real Claude session per rule, asked to break it with nothing else in the way. The last result stays,
 * with its date and Claude version; a Claude update since asks for a re-test.
 */
function ProveIt({
  state,
  onProven,
}: {
  state: GuardrailsState | null
  onProven: () => void
}): React.JSX.Element {
  const [running, setRunning] = useState<ProveKind | null>(null)
  const prove = async (kind: ProveKind): Promise<void> => {
    setRunning(kind)
    const r = await invoke('guardrails.prove', { kind })
    setRunning(null)
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    onProven()
  }
  return (
    <Group
      title="Prove it"
      description="Runs a short real Claude session in a temporary folder and asks it to break the rule, with nothing else in its way. This spends a small amount of tokens."
      testId="guardrail-prove"
    >
      {PROVE_KINDS.map((kind) => (
        <SettingRow
          key={kind}
          label={GUARDRAIL_INFO[kind].title}
          description={
            running === kind
              ? 'Running a short Claude session.'
              : proofText(
                  state?.proofs.find((p) => p.kind === kind),
                  state?.version ?? null,
                )
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={running !== null}
            onClick={() => {
              void prove(kind)
            }}
          >
            Prove it
          </Button>
        </SettingRow>
      ))}
    </Group>
  )
}

export function GuardrailsSection(): React.JSX.Element {
  const epoch = useConfigEpoch()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [state, setState] = useState<GuardrailsState | null>(null)
  const [nonce, setNonce] = useState(0)
  const [paths, setPaths] = useState('')
  const [secret, setSecret] = useState('')
  const [command, setCommand] = useState('')
  const [probe, setProbe] = useState('')

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void invoke('config.resolve', {}).then((r) => {
        if (!alive) return
        if (r.ok) setSettings(r.value.config.guardrails)
        else toast({ level: 'error', message: r.error.message })
      })
      // Proofs and the loosening record are extra: a core without them leaves those lines out.
      void invoke('guardrails.state', undefined)
        .then((r) => {
          if (alive && r.ok) setState(r.value)
        })
        .catch(() => undefined)
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [epoch, nonce])

  const write = useCallback(async (path: string, value: unknown, said: string): Promise<void> => {
    const r = await invoke('config.patch', { scope: 'user', ops: [{ op: 'replace', path, value }] })
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    setNonce((n) => n + 1)
    const backupId = r.value.backupId
    toast({
      id: UNDO_TOAST,
      level: 'info',
      message: said,
      ...(backupId !== null
        ? {
            action: {
              label: 'Undo',
              onClick: () =>
                void invoke('config.restoreBackup', { scope: 'user', backupId }).then(() => {
                  setNonce((n) => n + 1)
                }),
            },
          }
        : {}),
    })
  }, [])

  const addRule = (rule: GuardrailRule, said: string): void => {
    if (settings !== null) void write('/guardrails/rules', [...settings.rules, rule], said)
  }

  const results: RuleTestResult[] = useMemo(() => {
    const q = probe.trim()
    if (settings === null || q === '') return []
    const rules = rulesInForce(settings)
    return /[\s]/.test(q) ? testRules(rules, { command: q }) : testRules(rules, { path: q })
  }, [probe, settings])

  const has = (rule: GuardrailRule): boolean =>
    settings !== null && settings.rules.some((r) => ruleKey(r) === ruleKey(rule))
  const lastLoosened = state?.loosened.at(-1)

  const preset = settings?.preset ?? 'recommended'
  const fromPreset = presetRules(preset)
  const forbidden = fromPreset.filter((r) => r.kind === 'forbiddenCommand')
  const others = fromPreset.filter((r) => r.kind !== 'forbiddenCommand')
  const forbiddenLabel = `Forbidden commands: ${forbidden
    .map((r) => (r.kind === 'forbiddenCommand' ? r.argvPrefix.join(' ') : ''))
    .join(', ')}`

  return (
    <div className="flex flex-col gap-6" data-testid="settings-guardrails">
      <p className="text-sm text-muted-foreground">{NOT_A_BOUNDARY}</p>

      <Group title="Preset" description="A project can make these stricter. It can never make them looser.">
        <SettingRow label="Preset" description={PRESET_TEXT[preset].about} field="/guardrails/preset">
          <Select
            value={preset}
            disabled={settings === null}
            onValueChange={(v) => {
              void write(
                '/guardrails/preset',
                v,
                `Guardrails preset: ${PRESET_TEXT[v as GuardrailPreset].label}.`,
              )
            }}
          >
            <SelectTrigger aria-label="Guardrails preset" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRESET_TEXT).map(([id, t]) => (
                <SelectItem key={id} value={id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {lastLoosened !== undefined && (
          <p className="text-xs text-muted-foreground" data-testid="guardrail-loosened">
            Loosened on {dateText(lastLoosened.at)}: {lastLoosened.what}.
          </p>
        )}
      </Group>

      <Group title="Always on" description="Not removable, so a rule cannot be turned off from inside a run.">
        <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
          <span className="text-sm">Settings files</span>
          <span className="block text-xs text-muted-foreground break-words">
            {SELF_PROTECTED_PATHS.join(', ')}. A run that changes one has the change put back when its pass
            ends. CLAUDE.md and AGENTS.md stay editable.
          </span>
        </div>
      </Group>

      <Group title="Your rules" field="/guardrails/rules">
        {settings !== null && settings.rules.length === 0 && (
          <p className="text-sm text-muted-foreground">None yet.</p>
        )}
        {settings?.rules.map((rule, i) => (
          <RuleRow
            key={describeRule(rule)}
            rule={rule}
            onRemove={() => {
              void write(
                '/guardrails/rules',
                settings.rules.filter((_, at) => at !== i),
                'Rule removed.',
              )
            }}
          />
        ))}
        <SettingRow
          label="Protect files"
          description="Paths or patterns, separated by commas, such as migrations/**"
        >
          <Input
            aria-label="Files to protect"
            className="w-64"
            value={paths}
            onChange={(e) => {
              setPaths(e.target.value)
            }}
          />
          <Button
            variant="outline"
            disabled={settings === null || paths.trim() === ''}
            onClick={() => {
              const list = paths
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
              addRule({ kind: 'protectedFiles', paths: list }, 'Rule added.')
              setPaths('')
            }}
          >
            Add
          </Button>
        </SettingRow>
        <SettingRow
          label="Keep files private"
          description="Paths or patterns the AI may not read, separated by commas, such as .env*"
        >
          <Input
            aria-label="Files to keep private"
            className="w-64"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value)
            }}
          />
          <Button
            variant="outline"
            disabled={settings === null || secret.trim() === ''}
            onClick={() => {
              const list = secret
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
              addRule({ kind: 'privateFiles', paths: list }, 'Rule added.')
              setSecret('')
            }}
          >
            Add
          </Button>
        </SettingRow>
        {ONE_OF_A_KIND.map(({ rule, label }) => (
          <SettingRow key={rule.kind} label={label} description={GUARDRAIL_INFO[rule.kind].stops}>
            <Button
              variant="outline"
              disabled={settings === null || has(rule)}
              onClick={() => {
                addRule(rule, 'Rule added.')
              }}
            >
              Add
            </Button>
          </SettingRow>
        ))}
        <SettingRow
          label="Forbid a command"
          description="The program and its first words, such as terraform apply"
        >
          <Input
            aria-label="Command to forbid"
            className="w-64"
            value={command}
            onChange={(e) => {
              setCommand(e.target.value)
            }}
          />
          <Button
            variant="outline"
            disabled={settings === null || command.trim() === ''}
            onClick={() => {
              addRule(
                { kind: 'forbiddenCommand', argvPrefix: command.trim().split(/\s+/).slice(0, 8) },
                'Rule added.',
              )
              setCommand('')
            }}
          >
            Add
          </Button>
        </SettingRow>
      </Group>

      {fromPreset.length > 0 && (
        <Group title={`From the ${PRESET_TEXT[preset].label} preset`}>
          {forbidden.length > 0 && <RuleRow rule={forbidden[0] as GuardrailRule} label={forbiddenLabel} />}
          {others.map((rule) => (
            <RuleRow key={describeRule(rule)} rule={rule} />
          ))}
        </Group>
      )}

      <ProveIt
        state={state}
        onProven={() => {
          setNonce((n) => n + 1)
        }}
      />

      <ProjectSuggestions />

      <Group
        title="Test this rule"
        description="Type a path, or a command with its words. This costs nothing."
      >
        <Input
          aria-label="Path or command to test"
          value={probe}
          onChange={(e) => {
            setProbe(e.target.value)
          }}
        />
        {probe.trim() !== '' && results.every((r) => !r.applies) && (
          <p className="text-sm text-muted-foreground" data-testid="guardrail-test-none">
            No rule covers this.
          </p>
        )}
        {results
          .filter((r) => r.applies)
          .map((r) => (
            <p key={r.rule} className="text-sm" data-testid="guardrail-test-hit">
              {r.rule}: {r.outcome}
            </p>
          ))}
      </Group>
    </div>
  )
}
