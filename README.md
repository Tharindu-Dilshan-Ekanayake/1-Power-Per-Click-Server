# +1 Power Per Click — server

The multiplayer half of the game: lobby matchmaking and the position/swing relay
that lets players in the same lobby see each other. It is a Colyseus server on an
Express app, both on one port (see `src/realtime.js`).

The game plays fine without it. The client retries in the background and stays solo
until it connects, so the server being down or asleep costs nothing but company.

## Running it locally

```bash
npm install
npm run dev      # nodemon, restarts on save
npm start        # plain node
npm test         # the lobby matchmaking tests
```

It listens on `http://localhost:3000` unless `PORT` says otherwise.

## Environment

Copy `.env.example` for the full notes. The short version:

| variable | who sets it | what it does |
| --- | --- | --- |
| `PORT` | the host | port to listen on |
| `ALLOWED_ORIGINS` | you | comma-separated browser origins allowed to open a lobby socket |

`ALLOWED_ORIGINS` is the one that bites. Browsers always send an `Origin` header, and
`verifyClient` in `src/realtime.js` refuses any origin it does not recognise. The two
Vite dev origins are built in; every other one — the deployed game, a Netlify preview
URL, your phone on the Wi-Fi — has to be listed here or the socket is rejected with a
401 the player never sees. Origins are exact: scheme, host and port must match, and
there is no trailing slash.

The game is served from Netlify, so at minimum:

```
ALLOWED_ORIGINS=https://clicperpower.netlify.app
```

Netlify gives every branch and pull request its own origin
(`https://<branch>--clicperpower.netlify.app`,
`https://deploy-preview-<n>--clicperpower.netlify.app`). Those are separate origins and
are refused unless listed too, so add the ones you actually test from.

## Deploying to Render

`render.yaml` is a Blueprint, so the service is defined here rather than in a
dashboard. In Render: **New → Blueprint**, pick this repo, and it reads the file. It
will ask for `ALLOWED_ORIGINS`; if you do not know the game's address yet, put
anything and correct it afterwards under the service's **Environment** tab.

Then point the client at it. In Netlify — **Site configuration → Environment
variables** — set

```
VITE_SERVER_URL=https://power-per-click-server.onrender.com
```

and **trigger a new deploy**. Vite bakes its environment into the bundle at build
time, so a variable added after a build does nothing to that build; the site keeps
whatever address it was built with until it is rebuilt. You can check which one a
deploy actually shipped by searching its `assets/index-*.js` for `onrender.com`.

Use the `https://` address, not `http://`. The client turns it into the socket URL by
swapping the scheme (`lobbyClient.js`), so `http://` becomes `ws://` — and a browser on
an HTTPS page blocks a plain `ws://` connection as mixed content, silently.

### What the free plan means here

- **It sleeps.** After about 15 minutes with no traffic the instance spins down, and
  the next request waits roughly a minute while it starts. The client's reconnect
  backoff (`RETRY_MS` in `lobbyClient.js`) keeps trying, so the player is dropped into
  a lobby when it wakes rather than being left offline — they just play solo until then.
- **One instance.** Lobbies live in this process's memory (`src/lobbies.js`), so a
  second instance would be a second, separate set of lobbies and two players could be
  "online" without ever meeting. Scaling past one needs a shared Colyseus driver and
  presence (Redis) first — do not raise the instance count before that.

## Not done yet

- `POST /api/legion-auth` trusts `req.body.user` without verifying the Bloxity token.
- `POST /api/legion-webhook` does not check its secret header or dedupe by transaction.

Both are marked in `src/server.js`. Neither is reachable from the client yet, but
neither should stay this way once Bux purchases are wired up.
