const cors = require('cors')
const express = require('express')

const { attachRealtime } = require('./realtime')

const PORT = process.env.PORT || 3000

// Vite's dev server origin. Add the production origin(s) when you deploy, either
// here or as a comma-separated ALLOWED_ORIGINS environment variable.
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
]

// Express and the lobby room (Colyseus, over ws://host/ws-ish matchmaking - see
// realtime.js) share one HTTP server and port; Colyseus owns the Express app.
const realtime = attachRealtime({ allowedOrigins: ALLOWED_ORIGINS })
const { app } = realtime

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }),
)
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

/**
 * Auth passthrough for the Bloxity SDK.
 *
 * The frontend will POST `{ token, user }` here from
 * `Legion.SDK.auth.authenticateWithServer('/api/legion-auth')`.
 *
 * NOTE: not wired up on the frontend yet — this milestone is login + avatar +
 * movement. When you do wire it, call `authenticateWithServer` from
 * `client/src/bloxity/BloxityProvider.jsx` inside the `onUserChanged` handler, right
 * after a non-null user arrives, and stash the returned accessToken for your own
 * API calls.
 */
app.post('/api/legion-auth', (req, res) => {
  console.log('[legion-auth] payload:', JSON.stringify(req.body, null, 2))

  // TODO: verify the Bloxity JWT here before trusting req.body.user.
  // Until that happens `req.body.user` is attacker-controlled — anyone can POST any
  // legionId they like. Verify `req.body.token` against Bloxity's public key /
  // introspection endpoint and derive the user from the *verified* claims, not from
  // the body.

  res.json({
    accessToken: 'stub',
    user: { legionId: req.body.user?._id },
  })
})

/**
 * Webhook for future Bux purchases.
 * Responds 200 immediately — the platform will retry on anything else, so do the
 * real work asynchronously rather than holding the response open.
 */
app.post('/api/legion-webhook', (req, res) => {
  console.log('[legion-webhook] payload:', JSON.stringify(req.body, null, 2))

  // TODO: verify x-legion-webhook-secret header, dedupe by transactionId, grant the item.

  res.sendStatus(200)
})

/** Open lobbies and how full they are. */
app.get('/api/lobbies', (_req, res) => {
  res.json({ lobbies: realtime.lobbies.list() })
})

realtime.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (lobbies over Colyseus)`)
})
