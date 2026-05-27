import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { ActivityLogger } from './actions.js'

type Entity = Bot['entity']

const { goals } = pathfinderPkg
const { GoalNear, GoalXZ } = goals

// Behavior identity — what's currently running. Tick layer uses this to know
// if a switch is needed.
export type BehaviorId =
  | 'flee'
  | 'combat'
  | 'sleep'
  | 'go_home'
  | 'idle'
  | null

let currentBehavior: BehaviorId = null
let currentAbort: AbortController | null = null

// True while a user-initiated pathfinder goal (follow/moveTo/...) is alive.
// State machine reads this to keep the bot in executing_command instead of
// transitioning to sleeping/returning_home/idle which would cancel the goal.
let userPathfinderActive = false

export function setUserPathfinder(active: boolean): void {
  userPathfinderActive = active
}

export function hasUserPathfinder(): boolean {
  return userPathfinderActive
}

export function getCurrentBehavior(): BehaviorId {
  return currentBehavior
}

// Stop whatever is running (pathfinder, pvp, sleep). Idempotent.
// IMPORTANT: use setGoal(null) instead of pathfinder.stop() — stop() sets a
// `stopPathing` flag that survives until the next physicsTick processes it,
// and any setGoal called between then and the tick will trigger an internal
// stop() that wipes the new goal. setGoal(null) clears state immediately.
export function stopCurrentBehavior(bot: Bot): void {
  if (currentAbort) {
    currentAbort.abort()
    currentAbort = null
  }
  try { bot.pathfinder?.setGoal(null) } catch { /* noop */ }
  try { (bot as any).pvp?.stop() } catch { /* noop */ }
  currentBehavior = null
  userPathfinderActive = false
}

function startBehavior(id: BehaviorId, bot: Bot): AbortController {
  if (currentBehavior !== null) stopCurrentBehavior(bot)
  currentBehavior = id
  currentAbort = new AbortController()
  return currentAbort
}

// ── flee: run from nearest hostile when HP critical ───────────────────────────

const FLEE_DISTANCE = 24

export async function fleeBehavior(
  bot: Bot,
  threat: Entity,
  log: ActivityLogger,
): Promise<void> {
  const abort = startBehavior('flee', bot)
  log('danger', `Fleeing from ${threat.name ?? 'unknown'} (HP ${bot.health})`)

  // Compute opposite direction from threat and pick a faraway XZ goal.
  const dx = bot.entity.position.x - threat.position.x
  const dz = bot.entity.position.z - threat.position.z
  const length = Math.sqrt(dx * dx + dz * dz) || 1
  const targetX = Math.floor(bot.entity.position.x + (dx / length) * FLEE_DISTANCE)
  const targetZ = Math.floor(bot.entity.position.z + (dz / length) * FLEE_DISTANCE)

  try {
    await bot.pathfinder.goto(new GoalXZ(targetX, targetZ))
    if (!abort.signal.aborted) log('info', 'Reached safe distance')
  } catch (err: unknown) {
    if (!abort.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', `Flee path failed: ${msg}`)
    }
  } finally {
    if (currentBehavior === 'flee') currentBehavior = null
  }
}

// ── combat: engage nearest hostile via pvp plugin ─────────────────────────────

export async function combatBehavior(
  bot: Bot,
  target: Entity,
  log: ActivityLogger,
): Promise<void> {
  startBehavior('combat', bot)
  log('action', `Engaging ${target.name ?? 'hostile'}`)

  try {
    // Auto-equip best sword in inventory before attacking.
    await equipBestWeapon(bot)
    ;(bot as any).pvp.attack(target)
    // pvp plugin runs async; we don't await it. The tick loop will see when
    // the target dies/leaves and clear the behavior.
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log('info', `Combat error: ${msg}`)
    if (currentBehavior === 'combat') currentBehavior = null
  }
}

const WEAPON_PRIORITY = [
  'netherite_sword', 'diamond_sword', 'iron_sword',
  'stone_sword', 'wooden_sword', 'golden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe',
  'stone_axe', 'wooden_axe',
]

async function equipBestWeapon(bot: Bot): Promise<void> {
  for (const name of WEAPON_PRIORITY) {
    const item = bot.inventory.items().find((i) => i.name === name)
    if (item) {
      try { await bot.equip(item, 'hand') } catch { /* noop */ }
      return
    }
  }
}

// Called by tick layer to check if combat target is still valid.
export function isCombatTargetAlive(bot: Bot, target: Entity): boolean {
  const found = bot.entities[target.id]
  return found != null && found.isValid !== false
}

// ── sleep: find nearest bed and use it ────────────────────────────────────────

const BED_NAMES = [
  'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
  'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
  'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed',
]

export async function sleepBehavior(
  bot: Bot,
  log: ActivityLogger,
): Promise<boolean> {
  const abort = startBehavior('sleep', bot)
  log('action', 'Looking for a bed')

  const bedIds = BED_NAMES
    .map((name) => bot.registry.blocksByName[name]?.id)
    .filter((id): id is number => id != null)
  const beds = bot.findBlocks({ matching: bedIds, maxDistance: 32, count: 1 })

  if (beds.length === 0) {
    log('info', 'No bed found within 32 blocks')
    if (currentBehavior === 'sleep') currentBehavior = null
    return false
  }

  const bedPos = beds[0]
  const bedBlock = bot.blockAt(bedPos)
  if (!bedBlock) {
    if (currentBehavior === 'sleep') currentBehavior = null
    return false
  }

  try {
    await bot.pathfinder.goto(new GoalNear(bedPos.x, bedPos.y, bedPos.z, 2))
    if (abort.signal.aborted) return false
    await bot.sleep(bedBlock)
    log('info', 'Sleeping')
    return true
  } catch (err: unknown) {
    if (!abort.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', `Could not sleep: ${msg}`)
    }
    return false
  } finally {
    if (currentBehavior === 'sleep') currentBehavior = null
  }
}

// ── go_home: navigate back to a memorized base location ──────────────────────

export async function goHomeBehavior(
  bot: Bot,
  base: Vec3,
  log: ActivityLogger,
): Promise<void> {
  const abort = startBehavior('go_home', bot)
  log('action', `Returning to base (${Math.round(base.x)}, ${Math.round(base.y)}, ${Math.round(base.z)})`)

  try {
    await bot.pathfinder.goto(new GoalNear(base.x, base.y, base.z, 2))
    if (!abort.signal.aborted) log('info', 'Arrived at base')
  } catch (err: unknown) {
    if (!abort.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', `Go-home failed: ${msg}`)
    }
  } finally {
    if (currentBehavior === 'go_home') currentBehavior = null
  }
}
