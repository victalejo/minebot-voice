import { randomUUID } from 'node:crypto'
import type { Server } from 'socket.io'
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  BotStats,
  InventoryItem,
  ActivityEvent,
  BotState,
} from '@minebot/shared'
import { type ActivityLogger } from '../bot/actions.js'
import { getBot, getBotConfig } from '../bot/index.js'
import { requestConnect, requestDisconnect } from '../bot/bot-control.js'
import { getDb } from '../db/index.js'
import { startTick, type TickHandle } from '../bot/tick.js'
import { createGoalManager, type GoalManager } from '../bot/goals.js'
import { startPlannerLoop, type PlannerLoopHandle } from '../bot/planner-loop.js'
import { handleNaturalCommand } from '../bot/command-handler.js'
import { setupChatListener, type ChatListenerHandle } from '../bot/chat-listener.js'

type TypedIO = Server<ClientToServerEvents, ServerToClientEvents>

function makeActivityEvent(
  type: ActivityEvent['type'],
  message: string,
): ActivityEvent {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    type,
    message,
  }
}

function getInventoryItems(bot: Bot): InventoryItem[] {
  return bot.inventory.items().map((item) => ({
    slot: item.slot,
    name: item.name,
    displayName: item.displayName,
    count: item.count,
  }))
}

function buildStats(bot: Bot, state: BotState, currentGoal: string | null): BotStats {
  const position = bot.entity.position
  return {
    health: bot.health,
    food: bot.food,
    xp: {
      level: bot.experience.level,
      progress: bot.experience.progress,
    },
    position: {
      x: Math.round(position.x * 10) / 10,
      y: Math.round(position.y * 10) / 10,
      z: Math.round(position.z * 10) / 10,
    },
    state,
    timeOfDay: bot.time.timeOfDay,
    isRaining: bot.isRaining,
    currentGoal,
  }
}

const STATS_BROADCAST_INTERVAL_MS = 1000

export function setupSocketBridge(
  io: TypedIO,
  wireLifecycle: (bot: Bot) => void,
): {
  startBotListeners: (bot: Bot) => void
  stopBotListeners: () => void
} {
  let currentBot: Bot | null = null
  let onDeath: (() => void) | null = null
  let onSpawn: (() => void) | null = null
  let onEntityHurt: ((entity: any) => void) | null = null
  let tickHandle: TickHandle | null = null
  let statsInterval: ReturnType<typeof setInterval> | null = null
  let goalManager: GoalManager | null = null
  let plannerLoop: PlannerLoopHandle | null = null
  let chatListener: ChatListenerHandle | null = null

  let isExecutingCommand = false
  // Base location stays in memory for now — fase 2.5+ persists it as a "base"
  // row in the locations table.
  let baseLocation: Vec3 | null = null
  // Description of the currently-active goal, surfaced in BotStats.
  let currentGoal: string | null = null
  let lastEmittedState: BotState = 'idle'

  const MAX_COMMAND_LENGTH = 500
  const COMMAND_COOLDOWN_MS = 3000
  const commandTimestamps = new Map<string, number>()

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`)

    const bot = getBot()
    if (bot?.entity) {
      socket.emit('bot:status', 'connected')
      socket.emit('bot:inventory', getInventoryItems(bot))
      socket.emit('bot:stats', buildStats(bot, lastEmittedState, currentGoal))
    } else {
      socket.emit('bot:status', 'disconnected')
    }

    socket.on('disconnect', () => {
      commandTimestamps.delete(socket.id)
      console.log(`[Socket] Client disconnected: ${socket.id}`)
    })

    // TODO(multi-bot): recibir botId del payload y enrutarlo al bot correcto.
    socket.on('bot:connect', async () => {
      try {
        const config = getBotConfig() ?? readBotConfigFromEnv()
        await requestConnect(io, getDb(), config, wireLifecycle)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Socket] bot:connect failed:', msg)
        socket.emit('bot:activity', makeActivityEvent('danger', `No se pudo conectar: ${msg}`))
      }
    })

    socket.on('bot:disconnect', async () => {
      try {
        await requestDisconnect(io, getDb())
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Socket] bot:disconnect failed:', msg)
        socket.emit('bot:activity', makeActivityEvent('danger', `No se pudo desconectar: ${msg}`))
      }
    })

    socket.on('voice:command', async (command) => {
      const now = Date.now()
      const lastCommand = commandTimestamps.get(socket.id) ?? 0
      if (now - lastCommand < COMMAND_COOLDOWN_MS) {
        socket.emit('bot:activity', makeActivityEvent('info', 'Comando demasiado rápido, espera unos segundos'))
        return
      }
      commandTimestamps.set(socket.id, now)

      if (!command?.text || typeof command.text !== 'string' || command.text.length > MAX_COMMAND_LENGTH) {
        socket.emit('bot:activity', makeActivityEvent('info', 'Comando inválido o demasiado largo'))
        return
      }
      const bot = getBot()
      if (!bot?.entity) {
        io.emit('bot:activity', makeActivityEvent('info', 'Bot is not connected to any server'))
        return
      }

      await handleNaturalCommand(command.text, 'You', {
        io,
        bot,
        getGoalManager: () => goalManager,
        setExecuting: (v) => { isExecutingCommand = v },
      })
    })
  })

  function startBotListeners(bot: Bot): void {
    console.log('[Socket] Starting bot listeners')

    currentBot = bot

    // Memorize spawn point as initial base. Will be overridden once the goal
    // planner (fase 3) explicitly sets one.
    if (!baseLocation && bot.entity) {
      baseLocation = bot.entity.position.clone()
      console.log(`[Tick] Initial base set to spawn: ${baseLocation}`)
    }

    io.emit('bot:status', 'connected')
    io.emit('bot:inventory', getInventoryItems(bot))
    io.emit('bot:stats', buildStats(bot, lastEmittedState, currentGoal))

    onDeath = () => {
      console.log('[Bot] death event')
      io.emit('bot:status', 'dead')
      io.emit('bot:activity', makeActivityEvent('danger', 'Bot died — will respawn'))
    }

    onSpawn = () => {
      console.log('[Bot] spawn event (after death)')
      io.emit('bot:status', 'connected')
      io.emit('bot:activity', makeActivityEvent('info', 'Bot spawned / respawned'))
      io.emit('bot:inventory', getInventoryItems(bot))
      io.emit('bot:stats', buildStats(bot, lastEmittedState, currentGoal))
    }

    onEntityHurt = (entity: any) => {
      if (entity !== bot.entity) return
      io.emit('bot:activity', makeActivityEvent('danger', `Bot took damage (health: ${bot.health})`))

      if (bot.health <= 6) {
        io.emit('bot:activity', makeActivityEvent('danger', `Low health warning: ${bot.health}/20`))
      }
    }

    bot.on('death', onDeath)
    bot.on('spawn', onSpawn)
    bot.on('entityHurt', onEntityHurt)

    // ── Autonomy tick + Goal manager ────────────────────────────────
    const log: ActivityLogger = (type, message) => {
      io.emit('bot:activity', makeActivityEvent(type, message))
    }

    goalManager = createGoalManager({
      db: getDb(),
      bot,
      log,
      onChange: (goal) => {
        currentGoal = goal?.description ?? null
        io.emit('bot:goal', goal)
        io.emit('bot:stats', buildStats(bot, lastEmittedState, currentGoal))
      },
      // Higher-priority states keep the goal manager paused.
      isBusy: () => {
        if (isExecutingCommand) return true
        return ['fleeing', 'defending', 'sleeping', 'returning_home'].includes(
          lastEmittedState,
        )
      },
    })

    tickHandle = startTick(bot, {
      isExecutingCommand: () => isExecutingCommand,
      getBase: () => baseLocation,
      goalManager,
      log,
      onStateChange: (state) => {
        lastEmittedState = state
        io.emit('bot:stats', buildStats(bot, state, currentGoal))
      },
    })

    // ── Goal planner (IA decides next goal when idle) ──────────────
    plannerLoop = startPlannerLoop({
      bot,
      db: getDb(),
      goalManager,
      log,
      getState: () => lastEmittedState,
      getBase: () => baseLocation,
      memoryDir: process.env.MEMORY_DIR ?? './data/memories',
    })

    // ── In-game chat listener ("Juan, consigue madera") ────────────
    const botName = process.env.BOT_NAME ?? bot.username
    chatListener = setupChatListener(bot, {
      io,
      bot,
      getGoalManager: () => goalManager,
      setExecuting: (v) => { isExecutingCommand = v },
    }, botName)

    // ── Periodic stats broadcast (1s) ───────────────────────────────
    statsInterval = setInterval(() => {
      if (!bot.entity) return
      const state = tickHandle?.getState() ?? lastEmittedState
      io.emit('bot:stats', buildStats(bot, state, currentGoal))
    }, STATS_BROADCAST_INTERVAL_MS)
  }

  function stopBotListeners(): void {
    console.log('[Socket] Stopping bot listeners')

    if (currentBot) {
      if (onDeath) currentBot.removeListener('death', onDeath)
      if (onSpawn) currentBot.removeListener('spawn', onSpawn)
      if (onEntityHurt) currentBot.removeListener('entityHurt', onEntityHurt)
    }
    onDeath = null
    onSpawn = null
    onEntityHurt = null

    chatListener?.stop()
    chatListener = null

    plannerLoop?.stop()
    plannerLoop = null

    tickHandle?.stop()
    tickHandle = null

    goalManager?.stop()
    goalManager = null

    if (statsInterval) {
      clearInterval(statsInterval)
      statsInterval = null
    }
  }

  return { startBotListeners, stopBotListeners }
}

function readBotConfigFromEnv(): { host: string; port: number; username: string } {
  return {
    host: process.env.MINECRAFT_HOST ?? 'localhost',
    port: Number(process.env.MINECRAFT_PORT) || 25565,
    username: process.env.BOT_USERNAME ?? 'MineBot',
  }
}
