import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { greet, parseArgs } from './index.ts'

void test('greets the world by default', () => {
  assert.equal(greet(parseArgs([])), 'Hello, world!')
})

void test('greets by name and shouts on request', () => {
  assert.equal(greet(parseArgs(['Ada', '--shout'])), 'HELLO, ADA!')
})
