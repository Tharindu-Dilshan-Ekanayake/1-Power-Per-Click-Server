const colyseus = require('colyseus')
const { WebSocketTransport } = require('@colyseus/ws-transport')

const { LobbyManager } = require('./lobbies')
const { LobbyRoom } = require('./lobbyRoom')

/** Rejects any single message bigger than this outright. */
const MAX_MESSAGE_BYTES = 16 * 1024
/**
 * How often (and how many missed replies) before a connection is dropped as dead
 * (closed laptop, lost Wi-Fi) - lenient, so a briefly backgrounded tab survives.
 */
const HEARTBEAT_MS = 15000
const HEARTBEAT_RETRIES = 2

/**
 * Sets up the lobby room and matchmaking (see lobbyRoom.js for the protocol).
 *
 * Colyseus owns the HTTP server here, not the caller - its matchmaking endpoints
 * have to live on the same Express app the WebSocket upgrades are served from.
 * The caller gets that app back (`app`) to mount its own routes on, and a
 * `listen(port, cb)` to bind everything to one port.
 *
 * @param {{ allowedOrigins?: string[] }} [options]
 *   Browsers always send an Origin header; connections from other origins are
 *   refused. Non-browser clients (tests, tools) send none and are let through.
 * @returns {{ lobbies: LobbyManager, app: import('express').Application,
 *             listen: (port: number, cb?: () => void) => Promise<any>, close: () => Promise<void> }}
 */
function attachRealtime({ allowedOrigins } = {}) {
  const lobbies = new LobbyManager()

  const transport = new WebSocketTransport({
    maxPayload: MAX_MESSAGE_BYTES,
    pingInterval: HEARTBEAT_MS,
    pingMaxRetries: HEARTBEAT_RETRIES,
    verifyClient: ({ origin }) => !origin || !allowedOrigins || allowedOrigins.includes(origin),
  })
  const app = transport.getExpressApp()

  const gameServer = new colyseus.Server({ transport })
  gameServer.define('lobby', LobbyRoom, { lobbies })

  return {
    lobbies,
    app,
    listen: (port, cb) => gameServer.listen(port).then(() => cb?.()),
    close: () => gameServer.gracefullyShutdown(false),
  }
}

module.exports = { attachRealtime }
