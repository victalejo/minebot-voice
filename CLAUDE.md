# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MineBot: autonomous Minecraft bot (mineflayer) with a React dashboard for voice/text control, powered by an AI command parser (Anthropic Claude or OpenAI-compatible). Responses to the user are in Spanish.

## Commands

Yarn 1.22.19 monorepo driven by Turbo. Run from repo root:

```bash
yarn install
yarn dev       # turbo dev — runs bot (tsx watch) + web (vite) concurrently
yarn build     # turbo build — shared → web (vite) → bot (tsc)
yarn test      # turbo test — currently only the bot package has tests
```

Per-package commands (cd into `apps/bot` or `apps/web`):

```bash
# apps/bot
yarn dev                                       # tsx watch src/server.ts
yarn test                                      # vitest run
yarn test src/__tests__/state-machine.test.ts  # single test file
yarn test -t "pattern"                         # single test by name

# apps/web
yarn dev                                       # vite
yarn generate:textures                         # rebuild item texture atlas
```

Docker (production image = bot serving built web assets from `apps/web/dist`):

```bash
docker compose up -d                      # bot only (connects to external MC server)
docker compose -f docker-compose.server.yml up -d   # optional local Minecraft server
```

Before starting `yarn dev`/`turbo dev`, always check for orphaned watchers (see global CLAUDE.md rule) — `nest.*watch` is not used here, but `tsx watch` + `vite` can stack up the same way.

## Architecture

### Workspaces

- `apps/bot` — Node.js 22 ESM, TypeScript. Express + Socket.io server on port 3001, mineflayer bot, SQLite (better-sqlite3 + Drizzle), Anthropic or OpenAI SDK. Also serves the built web bundle in production.
- `apps/web` — React 19 + Vite. Connects to the bot via Socket.io (JWT in handshake auth).
- `packages/shared` — TS-only source package (`main` points directly at `src/types.ts`). Defines `BotAction`, `BotStats`, Socket.io event maps. Used by both apps.

The bot app is the single deployable unit; web builds into `apps/web/dist` and is served as static files by the Express app (with an SPA fallback).

### Bot control loop (the heart of the project)

Three-layer autonomy stack in `apps/bot/src/bot/`:

1. **`reflexes.ts`** — Pure sensor reads (HP, hostiles within 16b, night/shelter). No side effects.
2. **`behaviors.ts`** — Long-running cyclic behaviors: `flee`, `combat`, `sleep`, `go_home`. Each one owns an `AbortController` so `stopCurrentBehavior()` can interrupt cleanly.
3. **`tick.ts`** — `startTick(bot, ctx)` runs every 1.5s. `decideState()` picks one of `fleeing | defending | sleeping | executing_command | returning_home | gathering | idle` by strict priority; on state change it calls `stopCurrentBehavior()` + launches the new one. Each tick also calls `goalManager.pump()` which self-gates on `isBusy()`.

Layer 4 — goals (`bot/goals.ts` + `bot/gather.ts`): `GoalManager` is a queue of `gather` goals (wood/food/stone) persisted in the `goals` SQLite table. `pump()` picks the next pending goal when the bot is idle, marks it active, launches `gatherResourceBehavior`. Timeout: 5 min per goal. On bot restart `resetActiveGoals()` recovers orphans. `setGoal` and `cancelGoal` are `BotAction`s the AI can emit.

Layer 5 — planner (`ai/goal-planner.ts` + `bot/planner-loop.ts`): When state stays `idle` for ≥30s and no goal is pending, `planNextGoal()` calls DeepSeek (or Anthropic) to propose one. Throttled to 1 call per 5 min. Uses `PLANNER_MODEL` (defaults to AI_MODEL) and optional `PLANNER_THINKING=enabled` for DeepSeek V4 Pro thinking mode. Memory tool included so the planner can recall preferences across sessions. Disable with `PLANNER_ENABLED=false`.

Layer 6 — entry points (`bot/command-handler.ts` + `bot/chat-listener.ts`): both the dashboard socket (`voice:command`) and the in-game chat listener route through `handleNaturalCommand(text, speakerName, deps)`. The chat listener matches a regex built from `BOT_NAME` (defaults to `BOT_USERNAME`) at the start of every chat message; "Juan, consigue madera" strips the prefix and sends the rest as a command. Per-player cooldown of 3s; the bot self-filters its own chat to avoid feedback loops. Bare mentions (just the name) get a polite "¿sí?" reply without an AI call.

Layer 7 — locations (`db/locations.ts`): named landmarks (`base`, `chest_*`, `bed`, `other`) persisted in the `locations` table. The base is auto-seeded from the bot's spawn position on first connection and never overwritten unless the user explicitly says so (via `rememberHere`). `tick.ts` and the planner read the base via `getLocation(db, 'base')` instead of an in-memory cache. The parser includes `formatLocationsForPrompt(db)` output in the prompt so the AI can navigate by name (`goToLocation`).

Plugins (`plugins.ts`): pathfinder, auto-eat (eats at food<14), pvp, collectblock, armor-manager. `entitiesToAvoid` includes creeper/tnt. These plugins handle several reactions transparently — the autonomy layer doesn't re-implement eating or armor-equipping.

`socket/events.ts` orchestrates: spawn → wire bot listeners → create `GoalManager` → `startTick` → `startPlannerLoop`. A stats broadcast fires every 1s; state transitions also push an immediate stats update.

On bot `spawn`, `setupSocketBridge` calls `stopBotListeners()` first to avoid duplicate intervals/listeners on reconnect — this pattern matters because `createBot` auto-reconnects on `end` in `bot/index.ts`.

On spawn the bot chats `/effect give @s minecraft:resistance infinite 255 true` — the bot must be OP on the target server for this to work.

### AI command parser (`apps/bot/src/ai/command-parser.ts`)

Dual-provider: `AI_PROVIDER=anthropic` (default) or `openai`. The OpenAI branch is used with OpenAI-compatible APIs (DeepSeek V4 is the default model: `deepseek-v4-flash`; also works with MiniMax, OpenAI itself). `OPENAI_JSON_MODE` controls the JSON enforcement: `json_object` (default — works everywhere, parsed tolerantly by `extractJSON`) or `json_schema` (strict — only OpenAI and MiniMax support it; DeepSeek will reject it). The Anthropic branch always uses the tolerant `extractJSON` helper (strips code fences, falls back to first `{`…last `}`).

Both branches share:
- `SYSTEM_PROMPT` that forces raw-JSON-only output shaped as `{ understood, actions: BotAction[] }`.
- A `memory` tool (read/write/delete) backed by a JSON file at `${MEMORY_DIR}/bot-memories.json`. The agent loop iterates up to 5 tool-use rounds before giving up.
- A conversation-history context formatted from the `conversations` SQLite table (last 10 rows) so the bot remembers recent commands.

When adding new actions: update the `BotAction` union in `packages/shared/src/types.ts`, extend `ACTION_SCHEMA` in the parser, and add an executor in `bot/actions.ts`. The shared type is the contract between Claude's output and the executor.

### Persistence

SQLite via Drizzle (`apps/bot/src/db/`). Tables: `conversations` (command history), `bot_config` (singleton with `desiredState`), `goals` (autonomous queue — see goal manager), `locations` (named landmarks: base, chests). DB lives at `DB_PATH` (default `./data/minebot.sqlite`); memories at `MEMORY_DIR` (default `./data/memories`). Both mount to the `minebot-data` volume in Docker.

Follow the global rule: **never write manual SQL migrations** — use Drizzle Kit (`drizzle-kit`) to generate them from `schema.ts`.

### Auth

Simple password + JWT. `/api/login` is rate-limited (10/15min). JWT is verified in both the Express routes (`Authorization: Bearer`) and the Socket.io middleware (`socket.handshake.auth.token`). CORS origins come from `ALLOWED_ORIGINS` (comma-separated, empty = block all cross-origin).

### Web app

`App.tsx` toggles between `LoginPage` and `Dashboard` based on the auth hook. Dashboard subscribes to `bot:stats`, `bot:inventory`, `bot:activity`, `bot:status`, `command:response` and emits `voice:command` for both voice (browser SpeechRecognition in `useVoiceRecognition`) and text input. JWT is persisted in localStorage by `useAuth`.

## Environment variables

Required: `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` + `OPENAI_BASE_URL` when `AI_PROVIDER=openai`), `ACCESS_PASSWORD`, `JWT_SECRET`, `MINECRAFT_HOST`, `MINECRAFT_PORT`, `BOT_USERNAME`. Optional: `BOT_NAME` (chat-mention name, defaults to BOT_USERNAME), `AI_PROVIDER`, `AI_MODEL`, `OPENAI_JSON_MODE`, `OPENAI_THINKING`, `OPENAI_REASONING_EFFORT`, `PLANNER_ENABLED`, `PLANNER_MODEL`, `PLANNER_THINKING`, `PLANNER_REASONING_EFFORT`, `ALLOWED_ORIGINS`, `DB_PATH`, `MEMORY_DIR`, `ANTHROPIC_BASE_URL`.

## Deployment

`docker-compose.yml` is the Dokploy production config: internal-only (`expose: 3001`, no published ports), on the external `dokploy-network`. Do **not** add Traefik compose labels — Dokploy injects them from its domain config (global rule).
