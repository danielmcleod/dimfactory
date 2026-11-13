// Verify failures that point to something the AI made up: a module, an export, a property or a function that does not
// exist. Such a finding is flagged `possible-hallucination` (the code is wrong, not the machine). Pure.

/** The compiler and runtime messages that mean "this name does not exist". */
export const HALLUCINATION_SIGNALS: readonly { id: string; re: RegExp }[] = [
  // TypeScript: no exported member, cannot find module, property does not exist, did you mean, no exported member (did you mean).
  { id: 'ts', re: /\berror TS(?:2305|2307|2339|2551|2724)\b/ },
  // Node: a package or module the code names is not there.
  { id: 'node-module', re: /\bCannot find (?:module|package) ['"][^'"]+['"]/ },
  { id: 'node-export', re: /does not provide an export named ['"][^'"]+['"]/ },
  // Python.
  { id: 'python', re: /\b(?:ImportError|AttributeError|ModuleNotFoundError)\b/ },
  // Rust: cannot find value / unresolved import or path.
  { id: 'rust', re: /\berror\[E0(?:425|433|432)\]/ },
  // Go: undefined name.
  { id: 'go', re: /(?:^|[\s:])undefined: \S/m },
]

/** Whether a failing command's output points to an invented API (the ids of the signals it shows). */
export function hallucinationSignals(text: string): string[] {
  if (text === '') return []
  return HALLUCINATION_SIGNALS.filter((s) => s.re.test(text)).map((s) => s.id)
}

export const possibleHallucination = (text: string): boolean => hallucinationSignals(text).length > 0
