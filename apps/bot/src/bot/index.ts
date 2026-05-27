import mineflayer, { type Bot } from 'mineflayer'
import { loadPlugins } from './plugins.js'
import { stopCurrentBehavior, markTeleported } from './behaviors.js'
import { markPlayerAttacker } from './reflexes.js'

// If a player is within this many blocks when the bot takes damage, treat them
// as the attacker. 10 blocks covers melee, bow shots from close range, and
// position lag between client and server.
const ATTACKER_DETECT_RADIUS = 10

export interface BotConfig {
  host: string
  port: number
  username: string
}

// TODO(multi-bot): reemplazar por un mapa indexado por botId.
let bot: Bot | null = null
let savedConfig: BotConfig | null = null
let manualDisconnect = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleWirer: ((bot: Bot) => void) | null = null

const AUTH_LOGIN_DELAY_MS = 800
const RESISTANCE_APPLY_DELAY_MS = 4000
const AUTO_RECONNECT_DELAY_MS = 5000

export function getBot(): Bot | null {
  return bot
}

export function getBotConfig(): BotConfig | null {
  return savedConfig
}

// Registered once at startup so auto-reconnect can re-attach lifecycle
// broadcasters to the fresh bot instance (the reconnect path doesn't go
// through bot-control's requestConnect, which wires lifecycle explicitly).
export function setLifecycleWirer(fn: ((bot: Bot) => void) | null): void {
  lifecycleWirer = fn
}

export function connectBot(config: BotConfig): Bot {
  cancelPendingReconnect()

  if (bot) {
    replaceExistingBot(bot)
    bot = null
  }

  console.log(`[Bot] Connecting as ${config.username} to ${config.host}:${config.port}`)

  savedConfig = config
  manualDisconnect = false

  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: 'offline',
  })

  loadPlugins(bot)
  attachLifecycleLogs(bot)
  attachReconnectHandler(bot)

  return bot
}

export function disconnectBot(): void {
  cancelPendingReconnect()

  if (!bot) {
    // No active bot, but mark intent in case a reconnect fires before us.
    manualDisconnect = true
    return
  }

  console.log('[Bot] Manual disconnect requested')
  manualDisconnect = true
  safeQuit(bot)
  bot = null
}

function cancelPendingReconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

// Detach our reconnect handler first so an already-torn-down bot (e.g. mid-kick)
// can't schedule a stale reconnect. Then strip *every* listener so the old bot
// (and its chunk maps, entity tables, prismarine-physics state) can be GC'd.
// Without this each reconnect leaked ~250MB and the process OOM'd after a few
// timeout cycles.
function replaceExistingBot(oldBot: Bot): void {
  try { oldBot.removeAllListeners() } catch { /* swallow */ }
  try { (oldBot as any)._client?.removeAllListeners?.() } catch { /* swallow */ }
  safeQuit(oldBot)
}

function safeQuit(target: Bot): void {
  if (typeof target.quit !== 'function') return
  try {
    target.quit()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Bot] Error during quit:', msg)
  }
}

function attachLifecycleLogs(currentBot: Bot): void {
  currentBot.on('login', () => {
    console.log('[Bot] Logged in successfully')
  })

  currentBot.on('spawn', () => {
    console.log(`[Bot] Spawned at ${posStr(currentBot)}`)
    const authPassword = process.env.MC_AUTH_PASSWORD
    if (authPassword) {
      setTimeout(() => sendAuthPassword(currentBot, authPassword), AUTH_LOGIN_DELAY_MS)
    }
    // Track last finite position; if positions go NaN for too long, reconnect
    // so the server resyncs us.
    const posWatch = setInterval(() => {
      const p = currentBot.entity?.position
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
        lastValidPos = { x: p.x, y: p.y, z: p.z }
        lastValidAt = Date.now()
      } else if (lastValidAt && Date.now() - lastValidAt > 15000) {
        console.log('[Bot] Position has been NaN for >15s — forcing reconnect to resync.')
        lastValidAt = 0  // reset so we don't keep triggering
        try { currentBot.quit() } catch { /* swallow */ }
      }
    }, 500)
    const cleanup = () => clearInterval(posWatch)
    currentBot.once('end', cleanup)
    currentBot.once('death', cleanup)
  })

  currentBot.on('death', () => {
    console.log('[Bot] Died, will respawn')
  })

  let lastHp = 20
  currentBot.on('health', () => {
    const hp = currentBot.health
    if (hp < lastHp && currentBot.entity) {
      // Find the nearest player by scanning bot.entities (broader than
      // bot.players — catches players whose .entity hasn't been wired into
      // the players map yet). Any other player counts as the likely attacker.
      const myPos = currentBot.entity.position
      let nearestName: string | null = null
      let nearestDist = Infinity
      const playersSeen: string[] = []
      for (const e of Object.values(currentBot.entities)) {
        if (!e || e === currentBot.entity) continue
        if (e.type !== 'player' || !e.username) continue
        const dist = myPos.distanceTo(e.position)
        playersSeen.push(`${e.username}@${dist.toFixed(1)}b`)
        if (dist < nearestDist) {
          nearestDist = dist
          nearestName = e.username
        }
      }
      console.log(`[Bot] HP ${lastHp.toFixed(1)} → ${hp.toFixed(1)}; players visible: [${playersSeen.join(', ') || 'none'}]`)
      // Find the nearest player entity to fight back, even if positions are
      // NaN (which happens when chunks aren't fully loaded).
      let attackerEntity = null
      let attackerName: string | null = null
      for (const e of Object.values(currentBot.entities)) {
        if (!e || e === currentBot.entity) continue
        if (e.type !== 'player' || !e.username) continue
        attackerEntity = e
        attackerName = e.username
        break // just take the first visible player — overwhelmingly likely the attacker
      }

      if (attackerName && attackerEntity) {
        markPlayerAttacker(attackerName)
        if (currentBot.isSleeping) {
          currentBot.wake().catch(() => { /* already awake */ })
        }

        const pos = (attackerEntity as any).position
        const posValid = pos && Number.isFinite(pos.x)
        console.log(`[Bot]   → ATTACK ${attackerName} (pos valid: ${posValid})`)

        // Try to look at the attacker so the server registers the swing.
        // With NaN positions, lookAt would fail — so we guard.
        if (posValid) {
          try { currentBot.lookAt(pos.offset(0, 1.6, 0), true) } catch { /* swallow */ }
        }
        // Send 3 attack packets in quick succession. The server validates
        // using its own server-side positions, so even with broken local
        // entity tracking, the hits may register if we're in range.
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            try { currentBot.attack(attackerEntity) } catch { /* swallow */ }
          }, i * 250)
        }
        // Engage pvp pursuit only when positions look usable.
        if (posValid && Number.isFinite(currentBot.entity.position.x)) {
          try { ((currentBot as any).pvp).attack(attackerEntity) } catch { /* swallow */ }
        }
      }
    }
    lastHp = hp
  })

  // Server-forced position change (admin /tp, /spreadplayers, plugin TP, etc).
  // Without this, kevin keeps the pre-TP pathfinder goal and immediately walks
  // back toward wherever he was going before.
  currentBot.on('forcedMove', () => {
    console.log(`[Bot] forcedMove (teleport) → clearing pathfinder/behavior at ${posStr(currentBot)}`)
    stopCurrentBehavior(currentBot)
    markTeleported()
  })

  currentBot.on('kicked', (reason) => {
    console.log(`[Bot] Kicked: ${reason}`)
  })

  currentBot.on('error', (err) => {
    console.error('[Bot] Error:', err.message)
  })
}

function attachReconnectHandler(currentBot: Bot): void {
  currentBot.on('end', (reason) => {
    console.log(`[Bot] Disconnected: ${reason}`)
    bot = null

    // CRITICAL for memory: tear down every listener and the underlying client
    // immediately. Without this the old bot (and its chunk/entity/physics
    // state) stayed in memory until the next replaceExistingBot, leaking
    // ~250MB per cycle and OOMing the process after a few timeouts.
    setTimeout(() => {
      try { currentBot.removeAllListeners() } catch { /* swallow */ }
      try { (currentBot as any)._client?.removeAllListeners?.() } catch { /* swallow */ }
    }, 0)

    if (manualDisconnect) {
      console.log('[Bot] Manual disconnect — skipping auto-reconnect')
      return
    }

    if (!savedConfig) {
      console.log('[Bot] No saved config — skipping auto-reconnect')
      return
    }

    console.log(`[Bot] Auto-reconnecting in ${AUTO_RECONNECT_DELAY_MS}ms...`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (manualDisconnect) {
        console.log('[Bot] Pending reconnect aborted — manual disconnect in effect')
        return
      }
      const newBot = connectBot(savedConfig!)
      lifecycleWirer?.(newBot)
    }, AUTO_RECONNECT_DELAY_MS)
  })
}

function posStr(currentBot: Bot): string {
  const p = currentBot.entity?.position
  if (!p) return 'unknown'
  return `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`
}

// Track the last position that was finite so other modules can fall back
// to it when prismarine-physics corrupts bot.entity.position into NaN.
let lastValidPos: { x: number; y: number; z: number } | null = null
let lastValidAt = 0

export function getLastValidPosition(): { x: number; y: number; z: number } | null {
  if (!lastValidPos) return null
  return { ...lastValidPos }
}

export function getCurrentPosition(currentBot: Bot): { x: number; y: number; z: number } | null {
  const p = currentBot.entity?.position
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
    return { x: p.x, y: p.y, z: p.z }
  }
  return lastValidPos ? { ...lastValidPos } : null
}

function sendAuthPassword(currentBot: Bot, password: string): void {
  try {
    currentBot.chat(password)
    console.log('[Bot] Sent auth password to chat')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Bot] Could not send auth password:', msg)
  }
}

function applyResistanceEffect(currentBot: Bot): void {
  try {
    currentBot.chat('/effect give @s minecraft:resistance infinite 255 true')
    console.log('[Bot] Applied resistance immunity')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Bot] Could not apply resistance effect:', msg)
  }
}
