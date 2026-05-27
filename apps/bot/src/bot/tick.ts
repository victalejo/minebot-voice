import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import type { BotState } from '@minebot/shared'
import { readReflexes, REFLEX_THRESHOLDS } from './reflexes.js'
import {
  fleeBehavior,
  combatBehavior,
  sleepBehavior,
  goHomeBehavior,
  stopCurrentBehavior,
  getCurrentBehavior,
  type BehaviorId,
} from './behaviors.js'
import type { ActivityLogger } from './actions.js'
import type { GoalManager } from './goals.js'

const TICK_INTERVAL_MS = 1500

export interface AutonomyContext {
  // Bot is currently running a user-issued command. Tick yields to it.
  isExecutingCommand: () => boolean
  // Memorized base location (null if unknown). Used by go_home.
  getBase: () => Vec3 | null
  // Goal manager — null disables autonomous goal pursuit entirely.
  goalManager: GoalManager | null
  // Logger that pipes to dashboard + persistence.
  log: ActivityLogger
  // Notify whenever the state changes, so the socket layer can push it.
  onStateChange: (state: BotState) => void
}

// Decide the desired state given current sensor readings. Pure.
function decideState(
  bot: Bot,
  ctx: AutonomyContext,
): { state: BotState; reason: string } {
  if (ctx.isExecutingCommand()) {
    return { state: 'executing_command', reason: 'user command' }
  }

  const r = readReflexes(bot)

  // Safety always wins — flee/defend BEFORE checking user pathfinder goal.
  if (r.hp <= REFLEX_THRESHOLDS.HP_FLEE && r.nearestHostile) {
    return { state: 'fleeing', reason: `HP ${r.hp} + hostile near` }
  }
  if (
    r.nearestHostile &&
    r.hostileDistance <= REFLEX_THRESHOLDS.HOSTILE_CLOSE &&
    r.hp >= REFLEX_THRESHOLDS.HP_FIGHT_MIN
  ) {
    return { state: 'defending', reason: `hostile ${Math.round(r.hostileDistance)}b away` }
  }

  // User-initiated pathfinder goal (follow/moveTo) still active? Keep it.
  // Without this, sleeping/returning_home would stomp on the user's intent.
  if ((bot as any).pathfinder?.goal) {
    return { state: 'executing_command', reason: 'user goal active' }
  }

  // Night + safe — try to sleep
  if (r.isNight && !r.hostileCount && bot.isSleeping === false) {
    return { state: 'sleeping', reason: 'night + safe' }
  }

  // Have a base and far from it (>80 blocks) — go home
  const base = ctx.getBase()
  if (base) {
    const dist = bot.entity.position.distanceTo(base)
    if (dist > 80) {
      return { state: 'returning_home', reason: `${Math.round(dist)}b from base` }
    }
  }

  // Active goal? Switch to gathering. The goal manager runs the actual
  // behavior — tick just exposes the state for the dashboard.
  const activeGoal = ctx.goalManager?.getActive()
  if (activeGoal) {
    return { state: 'gathering', reason: `goal #${activeGoal.id}` }
  }

  return { state: 'idle', reason: 'nothing pressing' }
}

// Maps a state to the behavior that should be running for it.
function behaviorForState(state: BotState): BehaviorId {
  switch (state) {
    case 'fleeing': return 'flee'
    case 'defending': return 'combat'
    case 'sleeping': return 'sleep'
    case 'returning_home': return 'go_home'
    case 'idle': return 'idle'
    case 'gathering': return null  // managed by GoalManager.pump()
    case 'executing_command': return null  // managed externally
  }
}

export interface TickHandle {
  stop: () => void
  getState: () => BotState
}

// Start the autonomy loop. Returns a handle to stop it.
export function startTick(bot: Bot, ctx: AutonomyContext): TickHandle {
  let currentState: BotState = 'idle'
  let stopped = false

  const interval = setInterval(() => {
    if (stopped) return
    if (!bot.entity) return  // not spawned yet

    const { state, reason } = decideState(bot, ctx)

    // State changed? Stop the previous behavior and start the new one.
    if (state !== currentState) {
      console.log(`[Tick] ${currentState} → ${state} (${reason})`)
      currentState = state
      ctx.onStateChange(state)

      // Don't interrupt user commands or goal execution.
      if (state !== 'executing_command' && state !== 'gathering') {
        startBehaviorForState(bot, state, ctx)
      }
    } else {
      // Same state — check if behavior needs re-arming (e.g. combat target died).
      maybeReArmBehavior(bot, state, ctx)
    }

    // Always pump the goal manager — it self-gates on isBusy().
    ctx.goalManager?.pump()
  }, TICK_INTERVAL_MS)

  return {
    stop: () => {
      stopped = true
      clearInterval(interval)
      stopCurrentBehavior(bot)
    },
    getState: () => currentState,
  }
}

function startBehaviorForState(
  bot: Bot,
  state: BotState,
  ctx: AutonomyContext,
): void {
  const desired = behaviorForState(state)
  const current = getCurrentBehavior()
  if (desired === current) return

  // Going to idle: don't disturb the bot if no behavior was tracked.
  // User actions like follow/moveTo set pathfinder goals directly without
  // registering a behavior — stopping pathfinder here would cancel them.
  if (desired === null || desired === 'idle') {
    if (current !== null) stopCurrentBehavior(bot)
    return
  }

  // Switching to a real behavior — stop whatever was happening first.
  stopCurrentBehavior(bot)

  switch (desired) {
    case 'flee': {
      const r = readReflexes(bot)
      if (r.nearestHostile) {
        void fleeBehavior(bot, r.nearestHostile, ctx.log)
      }
      break
    }
    case 'combat': {
      const r = readReflexes(bot)
      if (r.nearestHostile) {
        void combatBehavior(bot, r.nearestHostile, ctx.log)
      }
      break
    }
    case 'sleep': {
      void sleepBehavior(bot, ctx.log)
      break
    }
    case 'go_home': {
      const base = ctx.getBase()
      if (base) void goHomeBehavior(bot, base, ctx.log)
      break
    }
  }
}

// When state hasn't changed but the active target may have (e.g. combat).
function maybeReArmBehavior(
  bot: Bot,
  state: BotState,
  ctx: AutonomyContext,
): void {
  if (state !== 'defending') return

  // If combat behavior cleared itself (target died, ran off), re-arm with the
  // next-nearest hostile if any.
  if (getCurrentBehavior() !== 'combat') {
    const r = readReflexes(bot)
    if (r.nearestHostile) {
      void combatBehavior(bot, r.nearestHostile, ctx.log)
    }
  }
}
