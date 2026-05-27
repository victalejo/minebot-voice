import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Bot } from 'mineflayer'
import type { Goal } from '@minebot/shared'
import * as schema from '../db/schema.js'
import {
  insertGoal,
  getActiveGoal,
  getNextPendingGoal,
  markGoalActive,
  markGoalCompleted,
  markGoalFailed,
  cancelAllGoals,
  resetActiveGoals,
  type InsertGoalInput,
} from '../db/goals.js'
import type { ActivityLogger } from './actions.js'
import { gatherResourceBehavior } from './gather.js'

type Db = BetterSQLite3Database<typeof schema>

const GOAL_TIMEOUT_MS = 5 * 60 * 1000  // 5 min

export interface GoalManager {
  // Push a goal onto the queue. Returns the persisted goal.
  enqueue: (input: InsertGoalInput) => Goal
  // Cancel everything: clears the queue and aborts whatever is running.
  cancelAll: () => void
  // Get the currently-active goal from DB (source of truth).
  getActive: () => Goal | null
  // Called by the tick loop on each idle tick to start/check goal execution.
  pump: () => void
  // Stop the manager (used during shutdown).
  stop: () => void
}

export interface GoalManagerDeps {
  db: Db
  bot: Bot
  log: ActivityLogger
  // Notify subscribers (socket layer) when the active goal changes.
  onChange: (goal: Goal | null) => void
  // True while a higher-priority state runs (combat, flee, sleep, command).
  // The manager won't start new goals while this returns true.
  isBusy: () => boolean
}

interface ExecutionHandle {
  goalId: number
  startedAt: number
  abort: AbortController
}

export function createGoalManager(deps: GoalManagerDeps): GoalManager {
  let execution: ExecutionHandle | null = null

  // Recover from a previous run: any "active" goals were orphaned by restart.
  resetActiveGoals(deps.db)

  function notify(): void {
    deps.onChange(getActiveGoal(deps.db))
  }

  function startGoal(goal: Goal): void {
    markGoalActive(deps.db, goal.id)
    const abort = new AbortController()
    execution = { goalId: goal.id, startedAt: Date.now(), abort }
    deps.log('info', `Goal #${goal.id}: ${goal.description}`)
    notify()

    runGoal(deps.bot, goal, abort.signal, deps.log)
      .then((result) => {
        // Only commit completion if the same execution is still active. If
        // someone cancelled mid-flight, the manager already wrote that status.
        if (execution?.goalId !== goal.id) return
        if (result.ok) {
          markGoalCompleted(deps.db, goal.id)
          deps.log('info', `Goal #${goal.id} completed`)
        } else {
          markGoalFailed(deps.db, goal.id, result.error)
          deps.log('info', `Goal #${goal.id} failed: ${result.error}`)
        }
        execution = null
        notify()
      })
      .catch((err: unknown) => {
        if (execution?.goalId !== goal.id) return
        const msg = err instanceof Error ? err.message : String(err)
        markGoalFailed(deps.db, goal.id, msg)
        deps.log('info', `Goal #${goal.id} crashed: ${msg}`)
        execution = null
        notify()
      })
  }

  function abortExecution(reason: string): void {
    if (!execution) return
    const { goalId, abort } = execution
    abort.abort()
    markGoalFailed(deps.db, goalId, reason)
    execution = null
  }

  return {
    enqueue(input) {
      const goal = insertGoal(deps.db, input)
      deps.log('info', `Queued goal: ${goal.description}`)
      return goal
    },

    cancelAll() {
      abortExecution('cancelled by user')
      cancelAllGoals(deps.db)
      deps.log('info', 'All goals cancelled')
      notify()
    },

    getActive: () => getActiveGoal(deps.db),

    pump() {
      // Already running something — check timeout.
      if (execution) {
        const elapsed = Date.now() - execution.startedAt
        if (elapsed > GOAL_TIMEOUT_MS) {
          deps.log('info', `Goal #${execution.goalId} timed out after ${Math.round(elapsed / 1000)}s`)
          abortExecution('timeout')
          notify()
        }
        return
      }

      // Yielding to higher-priority state (combat, etc.).
      if (deps.isBusy()) return

      const next = getNextPendingGoal(deps.db)
      if (next) startGoal(next)
    },

    stop() {
      if (execution) {
        execution.abort.abort()
        execution = null
      }
    },
  }
}

interface GoalResult {
  ok: boolean
  error: string
}

async function runGoal(
  bot: Bot,
  goal: Goal,
  signal: AbortSignal,
  log: ActivityLogger,
): Promise<GoalResult> {
  if (goal.kind === 'gather') {
    if (!goal.resource || !goal.targetCount) {
      return { ok: false, error: 'gather goal missing resource/targetCount' }
    }
    return gatherResourceBehavior(bot, goal.resource, goal.targetCount, signal, log)
  }

  if (goal.kind === 'free_text') {
    // free_text goals are placeholder for fase 3 (IA-driven). For now we
    // just log and mark complete so they don't block the queue.
    log('info', `Free-text goal not yet supported: ${goal.description}`)
    return { ok: false, error: 'free_text goals require IA planner (fase 3)' }
  }

  return { ok: false, error: `unknown goal kind: ${goal.kind}` }
}
