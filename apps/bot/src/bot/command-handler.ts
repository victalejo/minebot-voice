import { randomUUID } from 'node:crypto'
import type { Server } from 'socket.io'
import type { Bot } from 'mineflayer'
import type { ServerToClientEvents, ClientToServerEvents, ActivityEvent } from '@minebot/shared'
import { parseCommand } from '../ai/command-parser.js'
import { executeActions, type ActivityLogger } from './actions.js'
import { stopCurrentBehavior, getCurrentBehavior, hasUserPathfinder } from './behaviors.js'
import { getDb } from '../db/index.js'
import { saveConversation, getRecentHistory, formatHistoryForPrompt } from '../db/history.js'
import { formatLocationsForPrompt } from '../db/locations.js'
import type { GoalManager } from './goals.js'

type TypedIO = Server<ClientToServerEvents, ServerToClientEvents>

const MAX_COMMAND_LENGTH = 500

export interface CommandHandlerDeps {
  io: TypedIO
  bot: Bot
  getGoalManager: () => GoalManager | null
  setExecuting: (v: boolean) => void
}

export interface CommandOutcome {
  ok: boolean
  reason?: string
}

// Entry point shared by both the dashboard socket (voice:command) and the
// in-game chat listener. Caller is responsible for source-specific concerns
// (cooldowns, transport-level validation). This function does the parse +
// persistence + execution and broadcasts activity to the dashboard.
export async function handleNaturalCommand(
  text: string,
  speakerName: string,
  deps: CommandHandlerDeps,
  source: 'chat' | 'dashboard' = 'dashboard',
): Promise<CommandOutcome> {
  if (!text || typeof text !== 'string' || text.length > MAX_COMMAND_LENGTH) {
    return { ok: false, reason: 'invalid or too long' }
  }

  const { bot, io } = deps
  if (!bot.entity) return { ok: false, reason: 'bot not spawned' }

  console.log(`[Cmd] from ${speakerName}: "${text}"`)

  // Interrupt autonomous behavior so the command takes precedence.
  stopCurrentBehavior(bot)

  io.emit('bot:activity', makeActivity('command', `${speakerName}: ${text}`))
  deps.setExecuting(true)

  const pos = bot.entity.position
  const db = getDb()
  const ctx = {
    health: bot.health,
    food: bot.food,
    position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
    inventory: bot.inventory.items().map((i) => `${i.count}x ${i.name}`),
    timeOfDay: bot.time.timeOfDay,
    isRaining: bot.isRaining,
    knownLocations: formatLocationsForPrompt(db),
    speaker: speakerName,
    source,
    botName: process.env.BOT_NAME || bot.username,
    currentActivity: describeActivity(bot, deps.getGoalManager()),
  }

  try {
    const historyContext = formatHistoryForPrompt(getRecentHistory(db, 10))
    const memoryDir = process.env.MEMORY_DIR ?? './data/memories'

    const response = await parseCommand(text, ctx, { memoryDir }, historyContext)

    try {
      saveConversation(db, {
        player: speakerName,
        command: text,
        understood: response.understood,
        actions: response.actions,
      })
    } catch (err) {
      console.error('[Cmd] Failed to save conversation:', err)
    }

    io.emit('command:response', response)
    io.emit('bot:activity', makeActivity('info', `Understood: ${response.understood}`))

    const log: ActivityLogger = (type, message) => {
      io.emit('bot:activity', makeActivity(type, message))
    }
    await executeActions(bot, response.actions, {
      log,
      goalManager: deps.getGoalManager(),
      db,
    })

    return { ok: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Cmd] Error:', msg)
    io.emit('bot:activity', makeActivity('info', `Error: ${msg}`))
    return { ok: false, reason: msg }
  } finally {
    deps.setExecuting(false)
  }
}

function makeActivity(type: ActivityEvent['type'], message: string): ActivityEvent {
  return { id: randomUUID(), timestamp: Date.now(), type, message }
}

// Human-readable description of what the bot is doing RIGHT NOW. Fed into the
// AI prompt so questions like "que haces?" get an accurate answer (instead of
// the AI hallucinating activities).
function describeActivity(bot: Bot, goalManager: GoalManager | null): string {
  const goal = goalManager?.getActive()
  if (goal) {
    const desc = goal.description || `${goal.kind} ${goal.resource ?? ''} ${goal.targetCount ?? ''}`.trim()
    return `recolectando un objetivo: ${desc}`
  }

  const behavior = getCurrentBehavior()
  if (behavior === 'flee') return 'huyendo de un enemigo'
  if (behavior === 'combat') return 'peleando contra un enemigo'
  if (behavior === 'sleep') return 'durmiendo en una cama'
  if (behavior === 'go_home') return 'regresando a la base'

  if (hasUserPathfinder()) {
    const pf = (bot.pathfinder as any)?.goal
    const targetEntity = pf?.entity
    if (targetEntity?.username) return `siguiendo a ${targetEntity.username}`
    return 'caminando hacia un destino'
  }

  return 'sin nada que hacer en este momento, esperando órdenes'
}
