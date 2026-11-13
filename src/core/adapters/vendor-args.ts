// The vendor adapters' own extraArgs / flagMap launch rules for the recovery guard (the config_patch executor checks
// the vendor adapter's own extraArgs and flagMap launch rules over the values the ops write: Gemini's ACP rules, with
// combined short flags read letter by letter, Grok's and Muse's).
import type { VendorArgsCheck } from '../recovery/config-patch.ts'
import { acpExtraArgsProblem, acpFlagMapProblem } from './acp-base/launch.ts'
import { extraArgsProblem, flagMapProblem } from './claude/launch.ts'
import { geminiConfig } from './gemini/config.ts'
import { grokConfig } from './grok/config.ts'
import { museExtraArgsProblem, museFlagMapProblem } from './muse/launch.ts'

/**
 * A fix can never put a flag Dim Factory manages, or one that widens what a pass may do (Gemini `--yolo`, `-y`, also
 * inside `-dy`; Grok `--always-approve`, `--leader`), into `vendors.<id>.extraArgs` or a flagMap. Other vendors bring
 * theirs with their adapters.
 */
export const vendorArgsCheck: VendorArgsCheck = (vendor, v) =>
  vendor === 'claude'
    ? (extraArgsProblem(v.extraArgs) ?? flagMapProblem(v.flagMap))
    : vendor === 'gemini'
      ? (acpExtraArgsProblem(geminiConfig, v.extraArgs) ?? acpFlagMapProblem(geminiConfig, v.flagMap))
      : vendor === 'grok'
        ? (acpExtraArgsProblem(grokConfig, v.extraArgs) ?? acpFlagMapProblem(grokConfig, v.flagMap))
        : vendor === 'muse'
          ? // Muse's exec rules (`--approval-mode`, `--disable-sandbox`, … widen a pass or make exec wait).
            (museExtraArgsProblem(v.extraArgs) ?? museFlagMapProblem(v.flagMap))
          : undefined
