// The rooms of an online game: room codes, who is in which room, and the rule that the server decides every move.
// It never touches the network itself, so it is easy to test. server.js connects it to WebSockets.
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

import { randomInt } from 'node:crypto'

/** Longest message accepted, in bytes. Anything bigger is refused. */
export const MESSAGE_MAX_BYTES = 2048
/** One client may send at most RATE_MAX_MESSAGES messages in every RATE_WINDOW_MS milliseconds. */
export const RATE_MAX_MESSAGES = 20
export const RATE_WINDOW_MS = 1000
/** A client that is over the limit in this many windows in a row is told to close. */
export const RATE_STRIKES = 3

/** Letters and digits that cannot be mistaken for each other (no O, 0, I, 1, L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{4,8}$/

const MOVE_MAX_DEPTH = 4
const TYPES = ['create', 'join', 'move', 'leave']
const SKIPPED_KEYS = ['__proto__', 'constructor', 'prototype']

/** The default random source: an unguessable whole number from 0 up to (not including) max. */
const defaultRandom = (max) => randomInt(max)

/** Copies a JSON value, dropping dangerous keys. Returns undefined when it is too deep or not plain JSON. */
function plain(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (depth >= MOVE_MAX_DEPTH || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    const out = value.map((item) => plain(item, depth + 1))
    return out.includes(undefined) ? undefined : out
  }
  const out = {}
  for (const key of Object.keys(value)) {
    if (SKIPPED_KEYS.includes(key)) continue
    const item = plain(value[key], depth + 1)
    if (item === undefined) return undefined
    out[key] = item
  }
  return out
}

/**
 * Checks one text message from a browser.
 * @param {unknown} text
 * @returns {{ ok: true, message: object } | { ok: false, reason: string }}
 */
export function parseMessage(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'Messages must be text' }
  if (Buffer.byteLength(text) > MESSAGE_MAX_BYTES) return { ok: false, reason: 'Message too big' }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'Not valid JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'Expected an object' }
  const type = Object.hasOwn(raw, 'type') ? raw.type : undefined
  if (typeof type !== 'string' || !TYPES.includes(type)) return { ok: false, reason: 'Unknown message type' }
  if (type === 'join') {
    const code = Object.hasOwn(raw, 'code') ? raw.code : undefined
    if (typeof code !== 'string' || !ROOM_CODE_PATTERN.test(code)) return { ok: false, reason: 'Bad room code' }
    return { ok: true, message: { type, code } }
  }
  if (type === 'move') {
    const move = plain(Object.hasOwn(raw, 'move') ? raw.move : undefined)
    if (move === undefined) return { ok: false, reason: 'Bad move' }
    return { ok: true, message: { type, move } }
  }
  return { ok: true, message: { type } }
}

/**
 * @param {object} options
 * @param {{ initialState: Function, applyMove: Function, view?: Function }} options.rules The game's own rules.
 * @param {number} [options.maxPlayers] Players per room.
 * @param {number} [options.maxRooms] Open rooms at once.
 * @param {number} [options.codeLength] Characters in a room code (4 to 8).
 * @param {(max: number) => number} [options.random] A whole number from 0 up to max, not including max.
 * @param {() => number} [options.now] Milliseconds, for the rate limit.
 */
export function createRooms({
  rules,
  maxPlayers = 2,
  maxRooms = 200,
  codeLength = 5,
  random = defaultRandom,
  now = Date.now,
}) {
  const rooms = new Map()

  function newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = ''
      for (let i = 0; i < codeLength; i++) code += ROOM_CODE_ALPHABET[random(ROOM_CODE_ALPHABET.length)]
      if (!rooms.has(code)) return code
    }
    return null
  }

  function broadcast(room) {
    room.players.forEach((p, i) => {
      if (!p) return
      const state = rules.view ? rules.view(room.state, i) : room.state
      p.send({ type: 'state', state, you: i, code: room.code })
    })
  }

  function connect(send) {
    const client = { room: null, index: -1, send }
    let windowStart = now()
    let count = 0
    let warned = false
    let overRun = 0
    const fail = (reason) => client.send({ type: 'error', reason })

    function leave() {
      const room = client.room
      if (!room) return
      room.players[client.index] = null
      client.room = null
      for (const p of room.players) if (p) p.send({ type: 'left' })
      if (room.players.every((p) => !p)) rooms.delete(room.code)
    }

    function handle(message) {
      if (message.type === 'leave') return leave()
      if (message.type === 'create' || message.type === 'join') {
        if (client.room) return fail('Already in a room')
        let room
        if (message.type === 'create') {
          if (rooms.size >= maxRooms) return fail('Too many rooms, try again later')
          const code = newCode()
          if (!code) return fail('Could not make a room code')
          room = { code, players: [], state: null, started: false }
          rooms.set(code, room)
        } else {
          room = rooms.get(message.code)
          if (!room) return fail('No such room')
          if (room.started || room.players.length >= maxPlayers) return fail('Room is full')
        }
        client.room = room
        client.index = room.players.length
        room.players.push(client)
        if (room.players.length < maxPlayers) return client.send({ type: 'waiting', code: room.code, you: client.index })
        room.started = true
        room.state = rules.initialState(maxPlayers)
        return broadcast(room)
      }
      const room = client.room
      if (!room) return fail('Join a room first')
      if (!room.started) return fail('Waiting for another player')
      let result
      try {
        result = rules.applyMove(room.state, client.index, message.move)
      } catch {
        return fail('Move failed')
      }
      if (!result || !result.ok) return fail(result && typeof result.reason === 'string' ? result.reason : 'Move refused')
      room.state = result.state
      broadcast(room)
    }

    return {
      /** Handles one text message. Returns 'close' when the client keeps flooding and its socket should be closed. */
      receive(text) {
        const t = now()
        if (t - windowStart >= RATE_WINDOW_MS) {
          overRun = warned ? overRun + 1 : 0
          windowStart = t
          count = 0
          warned = false
        }
        if (++count > RATE_MAX_MESSAGES) {
          if (!warned) {
            warned = true
            fail('Too many messages')
          }
          return overRun + 1 >= RATE_STRIKES ? 'close' : undefined
        }
        const parsed = parseMessage(text)
        if (!parsed.ok) return fail(parsed.reason)
        handle(parsed.message)
      },
      /** The connection is gone: leave the room. */
      close: leave,
    }
  }

  return {
    connect,
    /** How many rooms are open. */
    get size() {
      return rooms.size
    },
  }
}
