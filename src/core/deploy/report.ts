// The Deploy helper's report for a folder (deploy.inspect, `dimf deploy`, the Run view's Deploy panel), and the plan
// the Deploy step of a run works from (which target, which config files are missing). No model, no network: the
// classification and the checklist are local, and the options and steps are the packs' data with the folder's values
// filled in. Nothing here runs a deploy command. For a static class it also says what "Make an upload file" would zip
// (upload.ts).
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BriefInput, Pack } from '../../shared/brief.ts'
import {
  DEPLOY_COMMANDS_CAVEAT,
  DEPLOY_CONFIG_PATH,
  DEPLOY_CONFIG_PURPOSE,
  DEPLOY_COST_CAVEAT,
  DEPLOY_SECURITY_CAVEAT,
} from '../../shared/deploy.ts'
import type {
  DeployClass,
  DeployConfigKind,
  DeployFileView,
  DeployPlanFacts,
  DeployReport,
} from '../../shared/deploy.ts'
import { DEPLOY_CONFIG_KINDS } from '../../shared/deploy.ts'
import { readHead } from '../git/branch.ts'
import { detectRepo } from '../git/repo.ts'
import { runChecklist } from './checklist.ts'
import type { FolderFiles } from './checklist.ts'
import { classifyDeploy, deployClassList } from './classify.ts'
import { optionViews, placeholderValues, recommendedTarget, shellOf, targetsFor } from './commands.ts'
import { readDeploySignals } from './signals.ts'
import { uploadView } from './upload.ts'
import type { DeploySignals } from './signals.ts'

export interface InspectOptions {
  folder: string
  packs: readonly Pack[]
  /** The brief (its category picks the pack; its choices classify first). */
  brief?: BriefInput | null
  task?: string
  /** The class the user picked (overrides the classification). */
  cls?: DeployClass
  /** The target the run or the user chose. */
  target?: string | null
  /** The manual ticks for this folder. */
  ticks?: Readonly<Record<string, number>>
  platform?: NodeJS.Platform
  /** Test seams. */
  signals?: DeploySignals
  files?: FolderFiles
  branch?: string | null
}

/** The config paths (DEPLOY_CONFIG_PATH) that exist in the folder. */
export async function presentConfigs(folder: string): Promise<Set<string>> {
  const out = new Set<string>()
  await Promise.all(
    DEPLOY_CONFIG_KINDS.map(async (k) => {
      const p = DEPLOY_CONFIG_PATH[k]
      try {
        if ((await stat(join(folder, ...p.split('/')))).isFile()) out.add(p)
      } catch {
        // Not there.
      }
    }),
  )
  return out
}

/** The current branch's short name (null outside a repository, on a detached HEAD, or when git cannot say). */
export async function currentBranch(folder: string): Promise<string | null> {
  try {
    const repo = await detectRepo(folder)
    if (!repo.isRepo || repo.dubiousOwnership === true) return null
    const head = await readHead(repo.toplevel ?? folder)
    return head.ref?.startsWith('refs/heads/') === true ? head.ref.slice('refs/heads/'.length) : null
  } catch {
    return null
  }
}

function hostingOf(brief: BriefInput | null | undefined): string[] {
  return brief?.fields['hosting']?.choices ?? []
}

/** deploy.inspect: classify, the options with their steps, and the checklist. */
export async function inspectDeploy(o: InspectOptions): Promise<DeployReport> {
  const signals = o.signals ?? (await readDeploySignals(o.folder))
  const cls = classifyDeploy(
    signals,
    {
      ...(o.brief !== undefined ? { brief: o.brief } : {}),
      ...(o.task !== undefined ? { task: o.task } : {}),
    },
    o.cls,
  )
  const category = o.brief?.category ?? 'software'
  const found = targetsFor(o.packs, category, cls.id)
  const branch = o.branch !== undefined ? o.branch : await currentBranch(o.folder)
  const values = placeholderValues(signals, cls.id, { branch })
  const [present, checks, upload] = await Promise.all([
    presentConfigs(o.folder),
    runChecklist(o.folder, cls.id, o.ticks ?? {}, o.files !== undefined ? { files: o.files } : {}),
    uploadView(o.folder, signals, cls.id, { game: (found?.pack.id ?? category) === 'games' }),
  ])
  const rec =
    found !== undefined
      ? recommendedTarget(found.targets, { chosen: o.target ?? null, hosting: hostingOf(o.brief) })
      : undefined
  const notes = [...checks.notes]
  if (found === undefined) notes.push(`No pack offers a deploy target for a ${cls.label.toLowerCase()} yet.`)
  return {
    folder: o.folder,
    category: found?.pack.id ?? category,
    cls,
    classes: deployClassList(),
    options:
      found !== undefined
        ? optionViews({
            pack: found.pack,
            targets: found.targets,
            recommended: rec?.id,
            values,
            shell: shellOf(o.platform),
            present,
            cls: cls.id,
          })
        : [],
    target: rec?.id ?? null,
    checklist: checks.items,
    env: checks.env,
    caveats: { cost: DEPLOY_COST_CAVEAT, security: DEPLOY_SECURITY_CAVEAT, commands: DEPLOY_COMMANDS_CAVEAT },
    notes,
    ...(upload !== undefined ? { upload } : {}),
  }
}

/** The files the Deploy step writes for a target: its configs that are missing (.env.example only when needed). */
export function filesToWrite(
  configs: readonly DeployConfigKind[],
  present: ReadonlySet<string>,
  envNames: readonly string[],
): DeployFileView[] {
  const kinds = new Set<DeployConfigKind>(configs)
  // Variables the code reads belong in .env.example whatever the target.
  if (envNames.length > 0) kinds.add('env-example')
  else kinds.delete('env-example')
  return DEPLOY_CONFIG_KINDS.filter((k) => kinds.has(k) && !present.has(DEPLOY_CONFIG_PATH[k])).map((k) => ({
    kind: k,
    path: DEPLOY_CONFIG_PATH[k],
    purpose: DEPLOY_CONFIG_PURPOSE[k],
  }))
}

/** The Deploy step's plan for a run's folder: the class, the target, the missing config files and the variables. */
export async function planDeploy(o: InspectOptions): Promise<DeployPlanFacts> {
  const [r, present] = await Promise.all([inspectDeploy(o), presentConfigs(o.folder)])
  const opt = r.options.find((x) => x.id === r.target)
  const env = r.env.map((v) => v.name)
  const files =
    opt !== undefined
      ? filesToWrite(
          opt.configs.map((c) => c.kind),
          present,
          r.env.filter((v) => !v.inExample).map((v) => v.name),
        )
      : []
  const uses = new Set(opt?.configs.map((c) => c.path) ?? [])
  return {
    cls: { id: r.cls.id, label: r.cls.label, confidence: r.cls.confidence },
    target: opt !== undefined ? { id: opt.id, label: opt.label } : null,
    files,
    present: [...present].filter((p) => uses.has(p) || p === DEPLOY_CONFIG_PATH['env-example']).sort(),
    env,
    notes: r.notes,
  }
}
