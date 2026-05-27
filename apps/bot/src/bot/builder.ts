import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { ActivityLogger } from './actions.js'

const { goals } = pathfinderPkg
const { GoalNear } = goals

// Mineflayer's placeBlock needs a reference block + the face vector pointing
// from the reference toward the target. Try all 6 neighbours.
const PLACEMENT_OFFSETS: Array<{ delta: Vec3; face: Vec3 }> = [
  { delta: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },   // place on top
  { delta: new Vec3(0, 1, 0),  face: new Vec3(0, -1, 0) },  // place under
  { delta: new Vec3(1, 0, 0),  face: new Vec3(-1, 0, 0) },
  { delta: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { delta: new Vec3(0, 0, 1),  face: new Vec3(0, 0, -1) },
  { delta: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
]

export interface PlaceResult {
  ok: boolean
  error: string
}

// Place a single block of `itemName` at `target`. Best-effort.
// Returns false on any failure mode (no item, no reference, out of reach).
export async function placeBlockAt(
  bot: Bot,
  itemName: string,
  target: Vec3,
): Promise<PlaceResult> {
  const item = bot.inventory.items().find((i) => i.name === itemName)
  if (!item) return { ok: false, error: `no ${itemName} in inventory` }

  const existing = bot.blockAt(target)
  if (existing && existing.boundingBox === 'block') {
    return { ok: true, error: '' }  // already filled, treat as success
  }

  try {
    await bot.equip(item, 'hand')
  } catch (err: unknown) {
    return { ok: false, error: `equip failed: ${describe(err)}` }
  }

  for (const { delta, face } of PLACEMENT_OFFSETS) {
    const refPos = target.plus(delta)
    const ref = bot.blockAt(refPos)
    if (!ref || ref.boundingBox !== 'block') continue

    // Need to be within ~5 blocks of the placement point.
    const dist = bot.entity.position.distanceTo(target)
    if (dist > 5) {
      try {
        await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 3))
      } catch {
        return { ok: false, error: 'cannot reach target' }
      }
    }

    try {
      await bot.placeBlock(ref, face)
      return { ok: true, error: '' }
    } catch (err: unknown) {
      // Try the next face — sometimes a face is blocked by terrain.
      continue
    }
  }

  return { ok: false, error: 'no usable reference block adjacent to target' }
}

// ── buildShelter: 3×3×3 cobble box centered at bot position ──────────────────

const SHELTER_COBBLE_NEEDED = 30
const BED_NAMES = [
  'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
  'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
  'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed',
]

function countInventory(bot: Bot, names: string[]): number {
  const set = new Set(names)
  return bot.inventory
    .items()
    .filter((i) => set.has(i.name))
    .reduce((sum, i) => sum + i.count, 0)
}

export async function buildShelter(bot: Bot, log: ActivityLogger): Promise<void> {
  const cobbleHave = countInventory(bot, ['cobblestone', 'cobbled_deepslate'])
  if (cobbleHave < SHELTER_COBBLE_NEEDED) {
    log('info', `Falta material: tengo ${cobbleHave} cobble, necesito ${SHELTER_COBBLE_NEEDED}`)
    return
  }

  const center = bot.entity.position.floored()
  log('action', `Construyendo refugio en (${center.x}, ${center.y}, ${center.z})`)

  // Step aside so the bot doesn't stand inside the build envelope.
  const standOff = center.offset(4, 0, 0)
  try {
    await bot.pathfinder.goto(new GoalNear(standOff.x, standOff.y, standOff.z, 1))
  } catch {
    // Continue anyway — placeBlockAt will retry pathing.
  }

  // Floor: 3×3 at Y-1
  for (const target of footprint(center.offset(0, -1, 0))) {
    await safePlace(bot, 'cobblestone', target, log)
    if (aborted(bot, log)) return
  }

  // Walls: perimeter at Y and Y+1, leaving door slot at (-1, Y, 0) and (-1, Y+1, 0)
  for (let dy = 0; dy <= 1; dy++) {
    for (const target of perimeter(center.offset(0, dy, 0))) {
      // Skip the door column (-X facing center)
      if (target.x === center.x - 1 && target.z === center.z) continue
      await safePlace(bot, 'cobblestone', target, log)
      if (aborted(bot, log)) return
    }
  }

  // Ceiling: 3×3 at Y+2
  for (const target of footprint(center.offset(0, 2, 0))) {
    await safePlace(bot, 'cobblestone', target, log)
    if (aborted(bot, log)) return
  }

  // Optional bed inside
  const bedItem = bot.inventory.items().find((i) => BED_NAMES.includes(i.name))
  if (bedItem) {
    log('action', `Colocando ${bedItem.name} dentro del refugio`)
    const res = await placeBlockAt(bot, bedItem.name, center.clone())
    if (!res.ok) log('info', `Cama no se pudo colocar: ${res.error}`)
  }

  log('info', 'Refugio terminado')
}

async function safePlace(
  bot: Bot,
  itemName: string,
  target: Vec3,
  log: ActivityLogger,
): Promise<void> {
  const res = await placeBlockAt(bot, itemName, target)
  if (!res.ok) {
    log('info', `Skip (${target.x},${target.y},${target.z}): ${res.error}`)
  }
}

// HP guard — abort builds if we're getting hammered.
function aborted(bot: Bot, log: ActivityLogger): boolean {
  if (bot.health < 8) {
    log('danger', `HP ${bot.health}, abortando construcción`)
    return true
  }
  return false
}

function footprint(centerLayer: Vec3): Vec3[] {
  const out: Vec3[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      out.push(centerLayer.offset(dx, 0, dz))
    }
  }
  return out
}

function perimeter(centerLayer: Vec3): Vec3[] {
  return footprint(centerLayer).filter((p) => {
    // Drop the center column — that's the bot's interior space.
    return !(p.x === centerLayer.x && p.z === centerLayer.z)
  })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
