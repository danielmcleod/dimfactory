// A tiny stdio MCP server for a permission probe: one harmless `echo` tool. It notes its start and each call in
// marker files next to itself, so the probe can tell whether it started and whether the tool really ran.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const here = import.meta.dirname
appendFileSync(join(here, 'echo-started.log'), 'started\n')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe-echo', version: '1.0.0' } } })
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Returns the given text unchanged.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (m.method === 'tools/call') {
    appendFileSync(join(here, 'echo-called.log'), 'called\n')
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params?.arguments?.text ?? '') }] } })
  } else {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
