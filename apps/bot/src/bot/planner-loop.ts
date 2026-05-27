import type { Bot } from 'mineflayer'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Vec3 } from 'vec3'
import type { BotState } from '@minebot/shared'
import * as schema from '../db/schema.js'
import { listRecentGoals } from '../db/goals.js'
import { formatLocationsForPrompt } from '../db/locations.js'
import { planNextGoal, type PlannerInput } from '../ai/goal-planner.js'
import type { GoalManager } from './goals.js'
import type { ActivityLogger } from './actions.js'

type Db = BetterSQLite3Database<typeof schema>

const POLL_INTERVAL_MS = 10_000   // check the trigger every 10s
const MIN_IDLE_MS = 30_000        // require 30s of idle before asking
const MIN_GAP_MS = 5 * 60_000     // at most one call every 5 min

const PLANNER_ENABLED = process.env.PLANNER_ENABLED !== 'false'

export interface PlannerLoopDeps {
  bot: Bot
  db: Db
  goalManager: GoalManager
  log: ActivityLogger
  getState: () => BotState
  getBase: () => Vec3 | null
  memoryDir: string
}

export interface PlannerLoopHandle {
  stop: () => void
}

export function startPlannerLoop(deps: PlannerLoopDeps): PlannerLoopHandle {
  if (!PLANNER_ENABLED) {
    console.log('[Planner] Disabled via PLANNER_ENABLED=false')
    return { stop: () => {} }
  }

  let idleSince: number | null = null
  let lastPlanAt = 0
  let inFlight = false
  let stopped = false

  const interval = setInterval(async () => {
    if (stopped) return
    if (inFlight) return
    if (!deps.bot.entity) return

    const state = deps.getState()

    // Only plan while genuinely idle.
    if (state !== 'idle') {
      idleSince = null
      return
    }
    if (idleSince === null) {
      idleSince = Date.now()
      return
    }
    const idleFor = Date.now() - idleSince
    if (idleFor < MIN_IDLE_MS) return

    // Don't ask too often.
    if (Date.now() - lastPlanAt < MIN_GAP_MS) return

    // Don't override existing work.
    if (deps.goalManager.getActive()) return

    inFlight = true
    lastPlanAt = Date.now()

    try {
      const input = buildPlannerInput(deps)
      console.log('[Planner] Asking for next goal...')
      const result = await planNextGoal(input, { memoryDir: deps.memoryDir })

      if (result.reasoning) {
        console.log(`[Planner] Reasoning: ${result.reasoning}`)
      }

      if (result.goal) {
        deps.log('info', `Planner: ${result.goal.description}`)
        deps.goalManager.enqueue({
          kind: 'gather',
          resource: result.goal.resource,
          targetCount: result.goal.count,
          description: result.goal.description,
        })
      } else {
        console.log('[Planner] No goal proposed — staying idle')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Planner] Loop iteration failed:', msg)
    } finally {
      inFlight = false
    }
  }, POLL_INTERVAL_MS)

  return {
    stop: () => {
      stopped = true
      clearInterval(interval)
    },
  }
}

function buildPlannerInput(deps: PlannerLoopDeps): PlannerInput {
  const pos = deps.bot.entity.position
  const base = deps.getBase()
  const baseDistance = base ? pos.distanceTo(base) : null

  // Recent terminal-state goals (last 5).
  const recent = listRecentGoals(deps.db, 50)
    .filter((g) => g.status !== 'pending' && g.status !== 'active')
    .slice(-5)
    .map((g) => ({
      description: g.description,
      status: g.status,
      error: g.error,
    }))

  return {
    health: deps.bot.health,
    food: deps.bot.food,
    position: {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
    },
    inventory: deps.bot.inventory.items().map((i) => `${i.count}x ${i.name}`),
    timeOfDay: deps.bot.time.timeOfDay,
    hasBase: base != null,
    baseDistance,
    recentGoals: recent,
    knownLocations: formatLocationsForPrompt(deps.db),
  }
}
