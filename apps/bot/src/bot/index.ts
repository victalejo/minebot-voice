import mineflayer, { type Bot } from 'mineflayer'
import { loadPlugins } from './plugins.js'
import { stopCurrentBehavior, markTeleported } from './behaviors.js'

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
// can't schedule a stale reconnect. Then attempt quit defensively.
function replaceExistingBot(oldBot: Bot): void {
  try {
    oldBot.removeAllListeners('end')
  } catch {
    // EventEmitter methods shouldn't throw, but be defensive.
  }
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
  })

  currentBot.on('death', () => {
    console.log('[Bot] Died, will respawn')
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
