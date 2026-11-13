import { greet, parseArgs } from './index.ts'

console.log(greet(parseArgs(process.argv.slice(2))))
