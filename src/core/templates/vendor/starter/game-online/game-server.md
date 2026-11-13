# The game server

This game can be played by two people over the internet. A small server (`server.js`) does three things:

- It shows the game's files to the browser, read-only.
- It lets players make a room and gives it a short code, like `K7MQ2`. A friend types the code to join.
- It decides every move. The browser only asks; the server checks the move against your rules and tells both players the new state. A cheating browser cannot change the game.

There are no accounts and no passwords. A room code is the only thing a player needs.

To play with people on other computers, the server has to run on a computer they can reach. That is a server you host yourself. Dim Factory does not host it for you.

## Run it

1. Run `npm install` once in the game folder (it installs the `ws` package).
2. Run `node server.js`.
3. Open http://127.0.0.1:8787/ in two browser windows. Make a room in one, type the code in the other.

The server prints one line when it is ready, for example `Game server: http://127.0.0.1:8787/`.

## Messages

Every message is a small piece of JSON text.

From the browser to the server:

- `{ "type": "create" }` makes a room.
- `{ "type": "join", "code": "K7MQ2" }` joins a room.
- `{ "type": "move", "move": ... }` plays a move. The move is plain JSON, at most 4 levels deep.
- `{ "type": "leave" }` leaves the room.

From the server to the browser:

- `{ "type": "waiting", "code": "K7MQ2", "you": 0 }` the room exists and is waiting for another player.
- `{ "type": "state", "state": ..., "you": 0, "code": "K7MQ2" }` the game state, sent to each player after every accepted move. `you` is that player's number.
- `{ "type": "error", "reason": "..." }` something was refused. Only the player who caused it hears this.
- `{ "type": "left" }` the other player has gone.

## Your rules: src/game/rules.js

All of your game's rules live in one file, `src/game/rules.js`, and run only on the server. It exports:

- `initialState(playerCount)` returns the starting state.
- `applyMove(state, playerIndex, move)` returns `{ ok: true, state: newState }` or `{ ok: false, reason: 'Not your turn' }`. Check everything here: whose turn it is, and whether the move is allowed. Never trust the move.
- `view(state, playerIndex)` (optional) returns what that player may see. Use it to hide secrets such as the other player's cards.

## Safety rules

- While you build the game, the server listens on 127.0.0.1, so only this computer can reach it.
- It checks the `Origin` of every WebSocket connection and refuses pages that are not on the allowed list.
- A message may be at most 2 KB, and a player may send at most 20 messages a second. A player who keeps flooding is disconnected.
- Every message is checked before it is used. Bad input gets an error, never a crash.
- The server decides every move, and it only serves the game's files: never `server.js`, `package.json`, `node_modules`, `src/server` or hidden files such as `.env`.
- Room codes are random and use letters and digits that are hard to mix up.

## Host it for real

1. Run the server on a computer that stays on, with Node 20 or newer.
2. Put your own HTTPS proxy in front of it (for example Caddy or nginx), so players use `https://` and the game talks over `wss://`.
3. Set the settings with environment variables:
   - `HOST` the address to listen on. The default is `127.0.0.1`. Keep it that way when the proxy runs on the same computer.
   - `PORT` the port to listen on. The default is `8787`.
   - `ALLOWED_ORIGINS` a comma list of the page addresses allowed to connect, for example `https://play.example.com`. Without it only the server's own local address is allowed.
4. Run `node server.js`, for example under a process manager so it restarts if it stops.

Part of the Dim Factory game starter. MIT License: copy, change and share it freely.
