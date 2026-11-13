// A profile's passes (per-pass keys, semantic rules, and Fix inheriting Implement's vendor, model and mode).
// A built-in profile reads as a table (read-only: Duplicate to edit). Your own profiles and a project's
// get the composer's pass-row pieces (pages/dashboard/composer: the vendor list, the model box, the mode names):
// vendor, model, mode within the semantic rules (Plan, Review and Critic read-only; never "Approve everything", which
// only Auto sets), on/off, and for Fix "same as Implement" (inherit) and reusing Implement's session. Each change is one
// config.patch of `/profiles/<name>/<pass>/<key>` in the profile's own file, with Undo (the caller writes).
import type { ProfileConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import { PASS_NAMES } from '@shared/run.ts'
import type { Mode, PassName } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { supportsEffort } from '@shared/vendors.ts'
import { EXTENSION_LEVEL_LABEL } from '@shared/extensions.ts'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { cn } from '../../../lib/cn.ts'
import { stepLabel } from '../../../lib/format.ts'
import {
  effortAfterModel,
  effortText,
  localPresetVendors,
  MODE_LABEL,
  modelHasNoPricing,
  modelText,
  vendorChoiceText,
  vendorChoices,
  vendorText,
} from '../../dashboard/composer/model.ts'
import type { ResolvedView } from '../../dashboard/composer/model.ts'
import { EffortSelect } from '../../dashboard/composer/EffortSelect.tsx'
import { ExtensionsSelect } from '../../dashboard/composer/ExtensionsSelect.tsx'
import { ModelField } from '../../dashboard/composer/ModelField.tsx'
import { useVendorModels } from '../../dashboard/composer/useVendorModels.ts'
import { SETTINGS_TABLE } from '../kit.tsx'
import { fieldOps, fileModes, inheritOps, passView, READ_ONLY, vendorOps } from './model.ts'
import type { PassView } from './model.ts'

export const SAME_AS_IMPLEMENT = 'Same as Implement'
export const INHERIT_LABEL = 'Same vendor, model and mode as Implement'
export const REUSE_LABEL = "Reuse Implement's session"
const NO_VENDOR = 'Not set'

export interface PassRowsEditorProps {
  name: string
  definition: ProfileConfig
  editable: boolean
  /** config.resolve's config (local presets for the vendor list); null until read. */
  config: ResolvedView | null
  probes: readonly ProbeView[]
  /** The control being written (`<pass>/<key>`), shown busy. */
  writing: string | null
  onWrite: (ops: JsonPatchOp[], message: string, key: string) => void
}

function vendorName(
  vendor: string | undefined,
  config: ResolvedView | null,
  probes: readonly ProbeView[],
): string {
  if (vendor === undefined) return NO_VENDOR
  return config !== null
    ? vendorText(vendor, config, probes)
    : (probes.find((p) => p.vendor === vendor)?.displayName ?? vendor)
}

/** A built-in profile, read-only. */
function PassTable({
  definition,
  config,
  probes,
}: Pick<PassRowsEditorProps, 'definition' | 'config' | 'probes'>): React.JSX.Element {
  const fix = passView(definition, 'fix')
  return (
    <>
      <div className={SETTINGS_TABLE.frame}>
        <table aria-label="Passes" data-testid="profile-passes-table" className={SETTINGS_TABLE.table}>
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {['Pass', 'Vendor', 'Model', 'Mode', 'Extensions', 'On'].map((c) => (
                <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PASS_NAMES.map((pass) => {
              const v = passView(definition, pass)
              const same = pass === 'fix' && v.sameAsImplement === true
              return (
                <tr key={pass} className="border-t" data-testid={`profile-pass-${pass}`}>
                  <th scope="row" className={cn(SETTINGS_TABLE.cell, 'font-normal')}>
                    {stepLabel(pass)}
                  </th>
                  <td className={SETTINGS_TABLE.cell}>
                    {same ? SAME_AS_IMPLEMENT : vendorName(v.vendor, config, probes)}
                  </td>
                  <td className={SETTINGS_TABLE.cell}>{same ? SAME_AS_IMPLEMENT : modelText(v.model)}</td>
                  <td className={SETTINGS_TABLE.cell}>{same ? SAME_AS_IMPLEMENT : MODE_LABEL[v.mode]}</td>
                  <td className={SETTINGS_TABLE.cell} data-testid={`profile-extensions-cell-${pass}`}>
                    {EXTENSION_LEVEL_LABEL[v.extensions]}
                  </td>
                  <td className={SETTINGS_TABLE.cell}>{v.enabled ? 'On' : 'Off'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="profile-fix-session">
        {fix.reuseSession === true
          ? "Fix reuses Implement's session when it runs on the same vendor."
          : 'Fix starts a fresh session.'}
      </p>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span aria-hidden className="text-xs text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function SameAsImplement({ impl, testId }: { impl: string; testId: string }): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      title={impl}
      className="flex h-7 w-36 items-center text-xs text-muted-foreground"
    >
      {SAME_AS_IMPLEMENT}
    </span>
  )
}

function EditableRow({
  pass,
  view,
  impl,
  props,
  models,
}: {
  pass: PassName
  view: PassView
  impl: PassView
  props: PassRowsEditorProps
  models: ReturnType<typeof useVendorModels>
}): React.JSX.Element {
  const { name, config, probes, writing, onWrite } = props
  const label = stepLabel(pass)
  const busy = (key: string): boolean => writing === `${pass}/${key}`
  const same = pass === 'fix' && view.sameAsImplement === true
  const presets = config !== null ? localPresetVendors(config) : []
  const choices = vendorChoices(probes, presets, view.vendor ?? '').filter((c) => c.id !== '')
  const chosen = choices.find((c) => c.id === view.vendor)
  const options = view.vendor !== undefined ? models.options(view.vendor) : null
  const implText = `Implement's: ${vendorName(impl.vendor, config, probes)} · ${modelText(impl.model)} · ${MODE_LABEL[impl.mode]}`
  const missingVendor = view.vendor === undefined && view.enabled && !same

  const vendorSelect = (
    <Select
      value={view.vendor ?? ''}
      disabled={busy('vendor')}
      onValueChange={(v) => {
        if (v === view.vendor) return
        onWrite(
          vendorOps(name, pass, v),
          `${name}: ${label} runs on ${vendorName(v, config, probes)}`,
          `${pass}/vendor`,
        )
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-36"
        data-testid={`profile-vendor-${pass}`}
        aria-label={`${label} vendor`}
        aria-invalid={missingVendor || undefined}
        // The whole choice ("Muse · Experimental · …") when the trigger cuts it.
        title={chosen !== undefined ? vendorChoiceText(chosen) : undefined}
      >
        <SelectValue placeholder="Choose a vendor" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {choices
            .filter((c) => c.group === 'primary')
            .map((c) => (
              <SelectItem key={c.id} value={c.id} disabled={c.disabled} title={c.title}>
                {vendorChoiceText(c)}
              </SelectItem>
            ))}
        </SelectGroup>
        {choices.some((c) => c.group === 'more') && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>More</SelectLabel>
              {choices
                .filter((c) => c.group === 'more')
                .map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={c.disabled} title={c.title}>
                    {vendorChoiceText(c)}
                  </SelectItem>
                ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  )

  const modes = fileModes(pass)
  const modeControl = READ_ONLY.has(pass) ? (
    <span
      data-testid={`profile-mode-${pass}`}
      title={`${label} always runs read-only`}
      className="flex h-7 w-36 items-center text-xs"
    >
      {MODE_LABEL.readonly}
    </span>
  ) : (
    <Select
      value={view.mode}
      disabled={busy('mode')}
      onValueChange={(v) => {
        if (v === view.mode) return
        onWrite(
          fieldOps(name, pass, 'mode', v),
          `${name}: ${label} mode ${MODE_LABEL[v as Mode]}`,
          `${pass}/mode`,
        )
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-36"
        data-testid={`profile-mode-${pass}`}
        aria-label={`${label} mode`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(modes.includes(view.mode) ? modes : [...modes, view.mode]).map((m) => (
          <SelectItem key={m} value={m}>
            {MODE_LABEL[m]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <li data-testid={`profile-pass-${pass}`} className="flex flex-col gap-1.5 border-b py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="w-20 shrink-0 text-sm font-medium">{label}</span>
        <Field label="Vendor">
          {same ? <SameAsImplement impl={implText} testId={`profile-vendor-${pass}`} /> : vendorSelect}
        </Field>
        <Field label="Model">
          {same ? (
            <SameAsImplement impl={implText} testId={`profile-model-${pass}`} />
          ) : (
            <ModelField
              pass={`profile-${pass}`}
              label={`${label} model`}
              value={view.model}
              options={options}
              noPricing={
                view.vendor !== undefined && modelHasNoPricing(view.vendor, view.model, options, null)
              }
              disabled={busy('model') || view.vendor === undefined}
              onWantOptions={() => {
                if (view.vendor !== undefined) models.want(view.vendor)
              }}
              onCommit={(model) => {
                // A level the new model does not list goes back to the default.
                const kept = effortAfterModel(options, model, view.effort)
                onWrite(
                  [
                    ...fieldOps(name, pass, 'model', model),
                    ...(kept !== view.effort ? fieldOps(name, pass, 'effort', kept) : []),
                  ],
                  `${name}: ${label} model ${modelText(model)}`,
                  `${pass}/model`,
                )
              }}
            />
          )}
        </Field>
        {!same && supportsEffort(view.vendor) && (
          <Field label="Effort">
            <EffortSelect
              id={`profile-${pass}`}
              label={`${label} effort`}
              model={view.model}
              value={view.effort}
              options={options}
              disabled={busy('effort')}
              onWantOptions={() => {
                if (view.vendor !== undefined) models.want(view.vendor)
              }}
              onChange={(effort) =>
                onWrite(
                  fieldOps(name, pass, 'effort', effort),
                  `${name}: ${label} ${effortText(effort).toLowerCase()}`,
                  `${pass}/effort`,
                )
              }
            />
          </Field>
        )}
        <Field label="Mode">
          {same ? <SameAsImplement impl={implText} testId={`profile-mode-${pass}`} /> : modeControl}
        </Field>
        <Field label="Extensions">
          <ExtensionsSelect
            id={`profile-${pass}`}
            pass={pass}
            label={`${label} extensions`}
            value={view.extensions}
            disabled={busy('extensions')}
            onChange={(level) =>
              onWrite(
                fieldOps(name, pass, 'extensions', level),
                `${name}: ${label} extensions ${EXTENSION_LEVEL_LABEL[level]}`,
                `${pass}/extensions`,
              )
            }
          />
        </Field>
        <Field label="On">
          <Switch
            data-testid={`profile-enabled-${pass}`}
            aria-label={`Run ${label}`}
            checked={view.enabled}
            disabled={busy('enabled')}
            onCheckedChange={(v) =>
              onWrite(
                fieldOps(name, pass, 'enabled', v),
                `${name}: ${label} ${v ? 'on' : 'off'}`,
                `${pass}/enabled`,
              )
            }
          />
        </Field>
      </div>
      {missingVendor && (
        <p role="alert" className="pl-24 text-xs text-destructive">
          {label} needs a vendor while it is on.
        </p>
      )}
      {pass === 'fix' && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 pl-24">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              data-testid="profile-fix-inherit"
              aria-label={INHERIT_LABEL}
              checked={view.inherit === 'implement'}
              disabled={busy('inherit')}
              onCheckedChange={(v) =>
                onWrite(
                  inheritOps(name, v, view),
                  v
                    ? `${name}: Fix uses Implement's vendor, model and mode`
                    : `${name}: Fix has its own vendor, model and mode`,
                  'fix/inherit',
                )
              }
            />
            <span aria-hidden>{INHERIT_LABEL}</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              data-testid="profile-fix-reuse"
              aria-label={REUSE_LABEL}
              checked={view.reuseSession !== false}
              disabled={busy('reuseSession')}
              onCheckedChange={(v) =>
                onWrite(
                  fieldOps(name, 'fix', 'reuseSession', v),
                  v ? `${name}: Fix reuses Implement's session` : `${name}: Fix starts a fresh session`,
                  'fix/reuseSession',
                )
              }
            />
            <span aria-hidden>{REUSE_LABEL}</span>
          </label>
        </div>
      )}
    </li>
  )
}

export function PassRowsEditor(props: PassRowsEditorProps): React.JSX.Element {
  const models = useVendorModels(props.probes)
  if (!props.editable)
    return <PassTable definition={props.definition} config={props.config} probes={props.probes} />
  const impl = passView(props.definition, 'implement')
  return (
    <ul aria-label="Passes" data-testid="profile-passes" className="flex flex-col">
      {PASS_NAMES.map((pass) => (
        <EditableRow
          key={pass}
          pass={pass}
          view={passView(props.definition, pass)}
          impl={impl}
          props={props}
          models={models}
        />
      ))}
    </ul>
  )
}
