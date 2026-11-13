// Greeting logic for the ts-small CLI.

export interface Options {
  name: string
  shout: boolean
}

export function parseArgs(argv: readonly string[]): Options {
  let name = 'world'
  let shout = false
  for (const arg of argv) {
    if (arg === '--shout') shout = true
    else if (!arg.startsWith('-')) name = arg
  }
  return { name, shout }
}

export function greet({ name, shout }: Options): string {
  const text = `Hello, ${name}!`
  return shout ? text.toUpperCase() : text
}
