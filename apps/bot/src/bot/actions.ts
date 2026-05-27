import type { Bot } from 'mineflayer'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { BotAction } from '@minebot/shared'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { GoalManager } from './goals.js'
import * as schema from '../db/schema.js'
import { setLocation, getLocation, deleteLocation } from '../db/locations.js'

const { goals } = pathfinderPkg
const { GoalNear, GoalFollow, GoalY } = goals

type Db = BetterSQLite3Database<typeof schema>

export type ActivityLogger = (
  type: 'danger' | 'command' | 'action' | 'info',
  message: string,
) => void

export interface ActionContext {
  log: ActivityLogger
  // Optional — without it, setGoal/cancelGoal are no-ops with a log warning.
  goalManager?: GoalManager | null
  // Optional — without it, rememberHere/goToLocation/forgetLocation log a warning.
  db?: Db | null
}

export async function executeAction(
  bot: Bot,
  action: BotAction,
  ctx: ActionContext,
): Promise<void> {
  const { log } = ctx
  switch (action.action) {
    case 'moveTo': {
      log('action', `Moving to (${action.x}, ${action.y}, ${action.z})`)
      const goal = new GoalNear(action.x, action.y, action.z, 1)
      await bot.pathfinder.goto(goal)
      log('info', `Arrived at (${action.x}, ${action.y}, ${action.z})`)
      break
    }

    case 'mine': {
      log('action', `Mining ${action.count}x ${action.block}`)
      const mcData = (bot as any).registry
      const blockType = bot.registry.blocksByName[action.block]
      if (!blockType) {
        log('info', `Unknown block: ${action.block}`)
        break
      }
      let collected = 0
      while (collected < action.count) {
        const blocks = bot.findBlocks({
          matching: blockType.id,
          maxDistance: 64,
          count: action.count - collected,
        })
        if (blocks.length === 0) {
          log('info', `No more ${action.block} found nearby`)
          break
        }
        for (const pos of blocks) {
          if (collected >= action.count) break
          const block = bot.blockAt(pos)
          if (!block) continue
          try {
            await (bot as any).collectBlock.collect(block)
            collected++
            log('info', `Collected ${action.block} (${collected}/${action.count})`)
          } catch (err: any) {
            log('info', `Could not collect ${action.block}: ${err?.message ?? String(err)}`)
          }
        }
        if (blocks.length < action.count - collected) break
      }
      break
    }

    case 'digDown': {
      log('action', `Digging down to Y=${action.toY}`)
      const goal = new GoalY(action.toY)
      await bot.pathfinder.goto(goal)
      log('info', `Reached Y=${action.toY}`)
      break
    }

    case 'follow': {
      log('action', `Following player: ${action.player}`)
      const entity = bot.players[action.player]?.entity
      if (!entity) {
        log('info', `Player ${action.player} not found nearby`)
        break
      }
      const goal = new GoalFollow(entity, 3)
      // GoalFollow is dynamic — setGoal with dynamic=true
      bot.pathfinder.setGoal(goal, true)
      log('info', `Now following ${action.player}`)
      break
    }

    case 'attack': {
      log('action', `Attacking entity: ${action.entity}`)
      const target = Object.values(bot.entities).find(
        (e) => e !== bot.entity && (e.name === action.entity || e.displayName === action.entity),
      )
      if (!target) {
        log('info', `Entity ${action.entity} not found`)
        break
      }
      ;(bot as any).pvp.attack(target)
      log('info', `Attacking ${action.entity}`)
      break
    }

    case 'craft': {
      log('action', `Crafting: ${action.item}`)
      const itemType = bot.registry.itemsByName[action.item]
      if (!itemType) {
        log('info', `Unknown item: ${action.item}`)
        break
      }
      const recipes = bot.recipesFor(itemType.id, null, 1, null)
      if (recipes.length === 0) {
        log('info', `No recipe found for ${action.item}`)
        break
      }
      await bot.craft(recipes[0], 1, undefined)
      log('info', `Crafted ${action.item}`)
      break
    }

    case 'equipItem': {
      log('action', `Equipping ${action.item} to ${action.destination}`)
      const item = bot.inventory.items().find((i) => i.name === action.item)
      if (!item) {
        log('info', `Item ${action.item} not in inventory`)
        break
      }
      await bot.equip(item, action.destination as Parameters<Bot['equip']>[1])
      log('info', `Equipped ${action.item} to ${action.destination}`)
      break
    }

    case 'dropItem': {
      log('action', `Dropping ${action.count}x ${action.item}`)
      const item = bot.inventory.items().find((i) => i.name === action.item)
      if (!item) {
        log('info', `Item ${action.item} not in inventory`)
        break
      }
      await bot.toss(item.type, null, action.count)
      log('info', `Dropped ${action.count}x ${action.item}`)
      break
    }

    case 'stop': {
      log('action', 'Stopping all activities')
      bot.pathfinder.stop()
      ;(bot as any).pvp.stop()
      log('info', 'Stopped')
      break
    }

    case 'say': {
      log('command', `Say: ${action.message}`)
      bot.chat(action.message)
      break
    }

    case 'setGoal': {
      if (!ctx.goalManager) {
        log('info', 'setGoal ignored: goal manager not initialised')
        break
      }
      const description =
        action.description ??
        `Recolectar ${action.count} de ${action.resource}`
      ctx.goalManager.enqueue({
        kind: 'gather',
        resource: action.resource,
        targetCount: action.count,
        description,
      })
      log('action', `Queued: ${description}`)
      break
    }

    case 'cancelGoal': {
      if (!ctx.goalManager) {
        log('info', 'cancelGoal ignored: goal manager not initialised')
        break
      }
      ctx.goalManager.cancelAll()
      break
    }

    case 'rememberHere': {
      if (!ctx.db) {
        log('info', 'rememberHere ignored: db not available')
        break
      }
      const pos = bot.entity.position
      const x = Math.floor(pos.x)
      const y = Math.floor(pos.y)
      const z = Math.floor(pos.z)
      setLocation(ctx.db, { name: action.name, kind: action.kind, x, y, z })
      log('action', `Saved "${action.name}" (${action.kind}) at (${x}, ${y}, ${z})`)
      break
    }

    case 'goToLocation': {
      if (!ctx.db) {
        log('info', 'goToLocation ignored: db not available')
        break
      }
      const loc = getLocation(ctx.db, action.name)
      if (!loc) {
        log('info', `No saved location named "${action.name}"`)
        break
      }
      log('action', `Walking to "${action.name}" (${loc.x}, ${loc.y}, ${loc.z})`)
      await bot.pathfinder.goto(new GoalNear(loc.x, loc.y, loc.z, 2))
      log('info', `Arrived at "${action.name}"`)
      break
    }

    case 'forgetLocation': {
      if (!ctx.db) {
        log('info', 'forgetLocation ignored: db not available')
        break
      }
      const existing = getLocation(ctx.db, action.name)
      if (!existing) {
        log('info', `Nothing to forget — "${action.name}" not saved`)
        break
      }
      deleteLocation(ctx.db, action.name)
      log('action', `Forgot location "${action.name}"`)
      break
    }

    case 'sleep': {
      log('action', 'Looking for a bed to sleep in')
      const bedNames = [
        'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
        'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
        'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
        'brown_bed', 'green_bed', 'red_bed', 'black_bed',
      ]
      const bedIds = bedNames
        .map((name) => bot.registry.blocksByName[name]?.id)
        .filter((id): id is number => id != null)
      const beds = bot.findBlocks({ matching: bedIds, maxDistance: 64, count: 1 })
      if (beds.length === 0) {
        log('info', 'No bed found nearby')
        break
      }
      const bedBlock = bot.blockAt(beds[0])
      if (!bedBlock) {
        log('info', 'Could not get bed block')
        break
      }
      try {
        log('action', `Pathfinding to bed at (${beds[0].x}, ${beds[0].y}, ${beds[0].z})`)
        await bot.pathfinder.goto(new GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2))
        log('action', 'Sleeping in bed')
        await bot.sleep(bedBlock)
        log('info', 'Sleeping...')
      } catch (err: any) {
        log('info', `Could not sleep: ${err?.message ?? String(err)}`)
      }
      break
    }

    default: {
      const exhaustive: never = action
      log('info', `Unknown action: ${(exhaustive as any).action}`)
    }
  }
}

export async function executeActions(
  bot: Bot,
  actions: BotAction[],
  ctx: ActionContext,
): Promise<void> {
  for (const action of actions) {
    await executeAction(bot, action, ctx)
  }
}
