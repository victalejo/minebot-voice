import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { pathfinder, Movements } from 'mineflayer-pathfinder'
import armorManager from 'mineflayer-armor-manager'
import { loader as autoEat } from 'mineflayer-auto-eat'
import { plugin as pvp } from 'mineflayer-pvp'
import { plugin as collectBlock } from 'mineflayer-collectblock'

const require = createRequire(import.meta.url)

export function loadPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(armorManager)
  bot.loadPlugin(autoEat)
  bot.loadPlugin(pvp)
  bot.loadPlugin(collectBlock)

  bot.once('spawn', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const mcData = require('minecraft-data')(bot.version) as unknown

    const movements = new Movements(bot)

    movements.canDig = true
    movements.allowParkour = true
    movements.allowSprinting = true
    movements.maxDropDown = 4
    movements.dontCreateFlow = true
    movements.dontMineUnderFallingBlock = true

    movements.entitiesToAvoid.add('creeper')
    movements.entitiesToAvoid.add('tnt')

    bot.pathfinder.setMovements(movements)

    bot.autoEat.opts = {
      priority: 'foodPoints',
      minHunger: 14,
      bannedFood: [],
      minHealth: 0,
      returnToLastItem: true,
      offhand: false,
      eatingTimeout: 3000,
      strictErrors: false,
    }

    console.log('[Plugins] All plugins loaded and configured')
  })
}
