const { WebSocketServer, WebSocket } = require('ws')

const { LobbyManager } = require('./lobbies')

/**
 * Real-time lobbies over WebSocket.
 *
 * Protocol: JSON messages with a `t` (type) field.
 *
 *   client -> server
 *     { t: 'hello', name, avatar, sword }   first message; joins a lobby
 *     { t: 'profile', name, avatar, sword } name / avatar / sword changed
 *     { t: 'state', p: [x, y, z], sw, ts }   own position; sw counts sword swings,
 *                                            ts is the sender's clock in ms
 *
 *   server -> client
 *     { t: 'welcome', id, lobby: { id, name, max }, players: [player...] }
 *     { t: 'join', player }  { t: 'leave', id }  { t: 'profile', id, name, avatar, sword }
 *     { t: 'states', s: [[id, x, y, z, sw, ts], ...] }   everyone who moved, 20 times a second
 *
 * Positions are batched per lobby each tick rather than relayed one by one, so eight
 * players moving cost each of them 20 messages a second, not 150+. Each carries its
 * sender's timestamp, so clients can play movement back smoothly at the pace it
 * actually happened, whatever the delivery timing.
 */

const TICK_MS = 1000 / 20
const HEARTBEAT_MS = 15000
/** A connection that hasn't said hello by then is dropped. */
const HELLO_TIMEOUT_MS = 5000
const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_AVATAR_BYTES = 4 * 1024
const MAX_MESSAGES_PER_SECOND = 40
const NAME_MAX = 24
const SWORD_MAX = 32
/** Positions outside this box are rejected as garbage. */
const WORLD_LIMIT = 10000

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

/** Sends to everyone in the lobby (except `except`), serialising the message once. */
function broadcast(lobby, message, except = null) {
  const data = JSON.stringify(message)
  for (const player of lobby.players.values()) {
    if (player !== except && player.socket.readyState === WebSocket.OPEN) player.socket.send(data)
  }
}

/** Name, avatar and sword from a hello/profile message, cleaned up. */
function readProfile(message) {
  const name = typeof message.name === 'string' ? message.name.trim().slice(0, NAME_MAX) : ''
  const sword = typeof message.sword === 'string' ? message.sword.slice(0, SWORD_MAX) : null
  let avatar = null
  if (message.avatar && typeof message.avatar === 'object') {
    const size = JSON.stringify(message.avatar).length
    if (size <= MAX_AVATAR_BYTES) avatar = message.avatar
  }
  return { name: name || 'Player', avatar, sword }
}

/** `[x, y, z]` rounded to centimetres, or null if it isn't a sane position. */
function readPosition(value) {
  if (!Array.isArray(value) || value.length !== 3) return null
  const out = []
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > WORLD_LIMIT) return null
    out.push(Math.round(n * 100) / 100)
  }
  return out
}

/** What other players get to see of a player (never the socket). */
function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    sword: player.sword,
    p: player.p,
    sw: player.sw,
  }
}

function lobbyInfo(lobby, manager) {
  return { id: lobby.id, name: lobby.name, max: manager.maxPlayers }
}

/**
 * Attaches the lobby WebSocket endpoint to an HTTP server.
 *
 * @param {import('http').Server} server
 * @param {{ path?: string, allowedOrigins?: string[] }} [options]
 *   Browsers always send an Origin header; connections from other origins are
 *   refused. Non-browser clients (tests, tools) send none and are let through.
 * @returns {{ lobbies: LobbyManager, close: () => void }}
 */
function attachRealtime(server, { path = '/ws', allowedOrigins } = {}) {
  const lobbies = new LobbyManager()
  const wss = new WebSocketServer({
    server,
    path,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: ({ origin }) => !origin || !allowedOrigins || allowedOrigins.includes(origin),
  })
  let nextPlayerId = 1

  wss.on('connection', (socket) => {
    socket.isAlive = true
    socket.on('pong', () => {
      socket.isAlive = true
    })

    let player = null
    const helloTimer = setTimeout(() => {
      if (!player) socket.close(4000, 'expected hello')
    }, HELLO_TIMEOUT_MS)

    let windowStart = Date.now()
    let windowCount = 0
    const overRate = () => {
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        windowCount = 0
      }
      return ++windowCount > MAX_MESSAGES_PER_SECOND
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary || overRate()) return
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!message || typeof message !== 'object') return

      if (!player) {
        if (message.t !== 'hello') return
        clearTimeout(helloTimer)
        player = {
          id: `p${nextPlayerId++}`,
          socket,
          ...readProfile(message),
          p: [0, 0, 0],
          sw: 0,
          ts: 0,
          moved: false,
        }
        const lobby = lobbies.join(player)
        send(socket, {
          t: 'welcome',
          id: player.id,
          lobby: lobbyInfo(lobby, lobbies),
          players: [...lobby.players.values()].filter((other) => other !== player).map(publicPlayer),
        })
        broadcast(lobby, { t: 'join', player: publicPlayer(player) }, player)
        console.log(
          `[lobby] ${player.name} (${player.id}) joined ${lobby.name} - ${lobby.players.size}/${lobbies.maxPlayers}`,
        )
        return
      }

      const lobby = lobbies.lobbyOf(player.id)
      if (!lobby) return

      if (message.t === 'state') {
        const p = readPosition(message.p)
        if (!p) return
        player.p = p
        if (Number.isSafeInteger(message.sw) && message.sw >= 0) player.sw = message.sw
        if (typeof message.ts === 'number' && Number.isFinite(message.ts) && message.ts >= 0) {
          player.ts = message.ts
        }
        player.moved = true
      } else if (message.t === 'profile') {
        Object.assign(player, readProfile(message))
        broadcast(lobby, { t: 'profile', id: player.id, name: player.name, avatar: player.avatar, sword: player.sword }, player)
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (!player) return
      const lobby = lobbies.leave(player.id)
      if (lobby) {
        broadcast(lobby, { t: 'leave', id: player.id })
        console.log(`[lobby] ${player.name} (${player.id}) left ${lobby.name} - ${lobby.players.size}/${lobbies.maxPlayers}`)
      }
      player = null
    })

    // A 'close' always follows an error, and that's where the cleanup happens.
    socket.on('error', () => {})
  })

  // Everyone who moved since the last tick, one message per lobby.
  const tick = setInterval(() => {
    for (const lobby of lobbies.lobbies.values()) {
      const moved = []
      for (const player of lobby.players.values()) {
        if (!player.moved) continue
        player.moved = false
        moved.push([player.id, ...player.p, player.sw, player.ts])
      }
      if (moved.length > 0) broadcast(lobby, { t: 'states', s: moved })
    }
  }, TICK_MS)

  // Drops connections that stopped answering pings (closed laptop, lost Wi-Fi).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate()
        continue
      }
      socket.isAlive = false
      socket.ping()
    }
  }, HEARTBEAT_MS)

  const close = () => {
    clearInterval(tick)
    clearInterval(heartbeat)
    for (const socket of wss.clients) socket.terminate()
    wss.close()
  }

  return { lobbies, close }
}

module.exports = { attachRealtime }
