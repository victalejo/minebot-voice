import type { Bot } from 'mineflayer'

// Bot.entities values — use the type mineflayer exposes to avoid prismarine-entity
// duplicate package mismatch (there are two copies in node_modules).
type Entity = Bot['entity']

// Hostile mob names. Anything in this set the bot considers a threat.
const HOSTILE_MOBS = new Set([
  'zombie',
  'skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'witch',
  'enderman',
  'pillager',
  'vindicator',
  'evoker',
  'ravager',
  'phantom',
  'drowned',
  'husk',
  'stray',
  'wither_skeleton',
  'piglin',
  'zombified_piglin',
  'hoglin',
  'zoglin',
  'blaze',
  'ghast',
  'magma_cube',
  'slime',
  'silverfish',
  'endermite',
  'guardian',
  'elder_guardian',
  'shulker',
])

export interface ReflexReading {
  hp: number
  food: number
  nearestHostile: Entity | null
  hostileDistance: number  // Infinity when none
  hostileCount: number     // hostiles within 16 blocks
  isNight: boolean
  hasShelter: boolean      // proxy: under a solid block within 5 above
}

const NIGHT_START = 13000
const NIGHT_END = 23000
const HOSTILE_SCAN_RADIUS = 16
const SHELTER_SCAN_HEIGHT = 5

function isHostile(entity: Entity): boolean {
  // mineflayer exposes type as 'mob' for most living non-player entities; the
  // name discriminator is what actually identifies hostility.
  if (entity.type !== 'mob') return false
  if (!entity.name) return false
  return HOSTILE_MOBS.has(entity.name)
}

function distanceTo(bot: Bot, entity: Entity): number {
  return bot.entity.position.distanceTo(entity.position)
}

// Read the bot's environment. Pure: no side effects.
export function readReflexes(bot: Bot): ReflexReading {
  let nearestHostile: Entity | null = null
  let nearestDistance = Infinity
  let hostileCount = 0

  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue
    if (!isHostile(entity)) continue

    const dist = distanceTo(bot, entity)
    if (dist > HOSTILE_SCAN_RADIUS) continue

    hostileCount++
    if (dist < nearestDistance) {
      nearestDistance = dist
      nearestHostile = entity
    }
  }

  const timeOfDay = bot.time.timeOfDay
  const isNight = timeOfDay >= NIGHT_START && timeOfDay <= NIGHT_END

  return {
    hp: bot.health,
    food: bot.food,
    nearestHostile,
    hostileDistance: nearestDistance,
    hostileCount,
    isNight,
    hasShelter: hasShelterAbove(bot),
  }
}

function hasShelterAbove(bot: Bot): boolean {
  const pos = bot.entity.position.floored()
  for (let dy = 1; dy <= SHELTER_SCAN_HEIGHT; dy++) {
    const block = bot.blockAt(pos.offset(0, dy, 0))
    if (block && block.boundingBox === 'block') return true
  }
  return false
}

// Decision thresholds — exported so tick.ts and behaviors can reference them.
export const REFLEX_THRESHOLDS = {
  HP_FLEE: 6,       // below this, run away
  HP_FIGHT_MIN: 8,  // need at least this to engage
  HOSTILE_CLOSE: 8, // distance at which a hostile is "engaging" us
} as const
