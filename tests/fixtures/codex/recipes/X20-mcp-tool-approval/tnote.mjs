// A tiny MCP stdio server for a fixture: one tool, save_note, that appends a line to notes.txt in its working folder.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined) return
  if (m.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tnote', version: '0.0.1' },
      },
    })
  } else if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          {
            name: 'save_note',
            description: 'Save a short note to notes.txt in the project folder.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      },
    })
  } else if (m.method === 'tools/call') {
    appendFileSync('notes.txt', `${String(m.params?.arguments?.text ?? '')}\n`)
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'saved' }] } })
  } else {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
