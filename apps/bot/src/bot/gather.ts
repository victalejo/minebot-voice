import type { Bot } from 'mineflayer'
import type { GatherResource } from '@minebot/shared'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { ActivityLogger } from './actions.js'

const { goals } = pathfinderPkg
const { GoalNear } = goals

type Entity = Bot['entity']

interface GatherResult {
  ok: boolean
  error: string
}

const SCAN_RADIUS = 64
const FOOD_MOB_SCAN_RADIUS = 32

// ── Resource → block/entity catalog ───────────────────────────────────────────

const WOOD_BLOCKS = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
]

const STONE_BLOCKS = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate']

const FOOD_MOBS = ['cow', 'pig', 'chicken', 'sheep', 'rabbit']

// Foods that count toward a food-gather goal (carried in inventory).
const FOOD_ITEMS = new Set([
  'beef', 'cooked_beef',
  'porkchop', 'cooked_porkchop',
  'chicken', 'cooked_chicken',
  'mutton', 'cooked_mutton',
  'rabbit', 'cooked_rabbit',
  'bread', 'apple', 'carrot', 'potato', 'baked_potato',
])

// Item names produced by mining a wood/stone block.
const WOOD_DROPS = new Set(WOOD_BLOCKS)
const STONE_DROPS = new Set(['cobblestone', 'cobbled_deepslate'])

// ── Inventory counters ────────────────────────────────────────────────────────

function countInInventory(bot: Bot, predicate: (name: string) => boolean): number {
  return bot.inventory
    .items()
    .filter((i) => predicate(i.name))
    .reduce((sum, item) => sum + item.count, 0)
}

function inventoryHasResource(bot: Bot, resource: GatherResource): number {
  switch (resource) {
    case 'wood': return countInInventory(bot, (n) => WOOD_DROPS.has(n))
    case 'stone': return countInInventory(bot, (n) => STONE_DROPS.has(n))
    case 'food': return countInInventory(bot, (n) => FOOD_ITEMS.has(n))
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function gatherResourceBehavior(
  bot: Bot,
  resource: GatherResource,
  targetCount: number,
  signal: AbortSignal,
  log: ActivityLogger,
): Promise<GatherResult> {
  const startCount = inventoryHasResource(bot, resource)
  const targetTotal = startCount + targetCount
  log('action', `Gathering ${targetCount} ${resource} (have ${startCount})`)

  switch (resource) {
    case 'wood':
    case 'stone':
      return gatherBlock(bot, resource, targetTotal, signal, log)
    case 'food':
      return gatherFood(bot, targetTotal, signal, log)
  }
}

// ── Block-based gathering (wood, stone) ───────────────────────────────────────

async function gatherBlock(
  bot: Bot,
  resource: 'wood' | 'stone',
  targetTotal: number,
  signal: AbortSignal,
  log: ActivityLogger,
): Promise<GatherResult> {
  const blockNames = resource === 'wood' ? WOOD_BLOCKS : STONE_BLOCKS
  const blockIds = blockNames
    .map((n) => bot.registry.blocksByName[n]?.id)
    .filter((id): id is number => id != null)

  if (blockIds.length === 0) {
    return { ok: false, error: `no block IDs resolved for ${resource}` }
  }

  // Hard cap on scan attempts to avoid infinite loops if the chunks don't load.
  let emptyScans = 0

  while (inventoryHasResource(bot, resource) < targetTotal) {
    if (signal.aborted) return { ok: false, error: 'aborted' }

    const positions = bot.findBlocks({
      matching: blockIds,
      maxDistance: SCAN_RADIUS,
      count: 5,
    })

    if (positions.length === 0) {
      emptyScans++
      if (emptyScans >= 3) {
        return { ok: false, error: `no ${resource} found in ${SCAN_RADIUS}b radius` }
      }
      // Move forward to fresh chunks before scanning again.
      await wanderOnce(bot, signal)
      continue
    }
    emptyScans = 0

    for (const pos of positions) {
      if (signal.aborted) return { ok: false, error: 'aborted' }
      if (inventoryHasResource(bot, resource) >= targetTotal) break

      const block = bot.blockAt(pos)
      if (!block) continue
      try {
        await (bot as any).collectBlock.collect(block)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log('info', `Skip block at ${pos}: ${msg}`)
        // Keep going — one bad block shouldn't fail the whole goal.
      }
    }
  }

  log('info', `Gathered ${resource} — have ${inventoryHasResource(bot, resource)}`)
  return { ok: true, error: '' }
}

async function wanderOnce(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  const dx = (Math.random() - 0.5) * 30
  const dz = (Math.random() - 0.5) * 30
  const tx = Math.floor(bot.entity.position.x + dx)
  const tz = Math.floor(bot.entity.position.z + dz)
  try {
    await bot.pathfinder.goto(new GoalNear(tx, bot.entity.position.y, tz, 3))
  } catch { /* noop */ }
}

// ── Mob-based gathering (food) ────────────────────────────────────────────────

async function gatherFood(
  bot: Bot,
  targetTotal: number,
  signal: AbortSignal,
  log: ActivityLogger,
): Promise<GatherResult> {
  let emptyScans = 0

  while (inventoryHasResource(bot, 'food') < targetTotal) {
    if (signal.aborted) return { ok: false, error: 'aborted' }

    const target = findFoodMob(bot)
    if (!target) {
      emptyScans++
      if (emptyScans >= 3) {
        return { ok: false, error: `no food mobs in ${FOOD_MOB_SCAN_RADIUS}b radius` }
      }
      await wanderOnce(bot, signal)
      continue
    }
    emptyScans = 0

    try {
      await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 2))
      if (signal.aborted) return { ok: false, error: 'aborted' }

      // pvp plugin handles weapon swing + retargeting.
      ;(bot as any).pvp.attack(target)
      // Wait for either the mob to die (drops collected by pickup) or timeout.
      await waitForMobDeath(bot, target, signal, 15_000)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', `Skip mob: ${msg}`)
    }
  }

  log('info', `Gathered food — have ${inventoryHasResource(bot, 'food')}`)
  return { ok: true, error: '' }
}

function findFoodMob(bot: Bot): Entity | null {
  let nearest: Entity | null = null
  let nearestDist = Infinity
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue
    if (entity.type !== 'mob') continue
    if (!entity.name || !FOOD_MOBS.includes(entity.name)) continue
    const dist = bot.entity.position.distanceTo(entity.position)
    if (dist > FOOD_MOB_SCAN_RADIUS) continue
    if (dist < nearestDist) {
      nearest = entity
      nearestDist = dist
    }
  }
  return nearest
}

async function waitForMobDeath(
  bot: Bot,
  target: Entity,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) return
    const still = bot.entities[target.id]
    if (!still || still.isValid === false) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
