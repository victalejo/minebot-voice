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
const HOSTILE_MOB_SCAN_RADIUS = 40

// ── Resource → block/entity catalog ───────────────────────────────────────────

const WOOD_BLOCKS = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
]

const STONE_BLOCKS = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate']
const IRON_BLOCKS = ['iron_ore', 'deepslate_iron_ore']

const FOOD_MOBS = ['cow', 'pig', 'chicken', 'sheep', 'rabbit']

// Hostile mobs that sometimes drop armor pieces, swords, or bows when killed.
const ARMOR_DROPPING_MOBS = ['zombie', 'skeleton', 'husk', 'stray', 'drowned', 'zombie_villager']

// Item-name matchers for inventory checks.
const ARMOR_ITEMS = new Set([
  'leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots',
  'chainmail_helmet', 'chainmail_chestplate', 'chainmail_leggings', 'chainmail_boots',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
  'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
  'turtle_helmet',
])

const IRON_ITEMS = new Set(['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore'])

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
    case 'armor': return countInInventory(bot, (n) => ARMOR_ITEMS.has(n))
    case 'iron': return countInInventory(bot, (n) => IRON_ITEMS.has(n))
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
    case 'iron':
      return gatherBlock(bot, 'iron', targetTotal, signal, log)
    case 'food':
      return gatherFood(bot, targetTotal, signal, log)
    case 'armor':
      return gatherArmor(bot, targetTotal, signal, log)
  }
}

// ── Block-based gathering (wood, stone) ───────────────────────────────────────

async function gatherBlock(
  bot: Bot,
  resource: 'wood' | 'stone' | 'iron',
  targetTotal: number,
  signal: AbortSignal,
  log: ActivityLogger,
): Promise<GatherResult> {
  const blockNames =
    resource === 'wood' ? WOOD_BLOCKS :
    resource === 'stone' ? STONE_BLOCKS :
    IRON_BLOCKS
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

    const p = bot.entity?.position
    if (!p || !Number.isFinite(p.x)) {
      // Position is NaN — wait for chunks to load instead of looping pathfinder.
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }

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
  const p = bot.entity?.position
  // If position is NaN (chunks not loaded yet on this fabric server), bail out
  // — pathfinder.goto with NaN goal would loop allocating astar nodes.
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    await new Promise((r) => setTimeout(r, 1000))
    return
  }
  const dx = (Math.random() - 0.5) * 30
  const dz = (Math.random() - 0.5) * 30
  const tx = Math.floor(p.x + dx)
  const tz = Math.floor(p.z + dz)
  try {
    await bot.pathfinder.goto(new GoalNear(tx, Math.floor(p.y), tz, 3))
  } catch { /* noop */ }
}

// ── Armor: hunt hostile mobs that drop armor pieces ──────────────────────────

async function gatherArmor(
  bot: Bot,
  targetTotal: number,
  signal: AbortSignal,
  log: ActivityLogger,
): Promise<GatherResult> {
  let emptyScans = 0

  while (inventoryHasResource(bot, 'armor') < targetTotal) {
    if (signal.aborted) return { ok: false, error: 'aborted' }

    const p = bot.entity?.position
    if (!p || !Number.isFinite(p.x)) {
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }

    const target = findHostileMob(bot)
    if (!target) {
      emptyScans++
      if (emptyScans >= 4) {
        return { ok: false, error: `no armor-dropping mobs in ${HOSTILE_MOB_SCAN_RADIUS}b radius` }
      }
      await wanderOnce(bot, signal)
      continue
    }
    emptyScans = 0

    try {
      const tp = target.position
      if (Number.isFinite(tp.x)) {
        await bot.pathfinder.goto(new GoalNear(tp.x, tp.y, tp.z, 2))
      }
      if (signal.aborted) return { ok: false, error: 'aborted' }
      ;(bot as any).pvp.attack(target)
      await waitForMobDeath(bot, target, signal, 20_000)
      // Give a moment for drops to land and pickup to happen.
      await new Promise((r) => setTimeout(r, 1500))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log('info', `Skip armor mob: ${msg}`)
    }
  }

  log('info', `Gathered armor — have ${inventoryHasResource(bot, 'armor')}`)
  return { ok: true, error: '' }
}

function findHostileMob(bot: Bot): Entity | null {
  let nearest: Entity | null = null
  let nearestDist = Infinity
  const myPos = bot.entity?.position
  if (!myPos || !Number.isFinite(myPos.x)) return null
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue
    if (entity.type !== 'mob') continue
    if (!entity.name || !ARMOR_DROPPING_MOBS.includes(entity.name)) continue
    const tp = entity.position
    if (!tp || !Number.isFinite(tp.x)) continue
    const dist = myPos.distanceTo(tp)
    if (dist > HOSTILE_MOB_SCAN_RADIUS) continue
    if (dist < nearestDist) {
      nearest = entity
      nearestDist = dist
    }
  }
  return nearest
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
