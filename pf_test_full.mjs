import mineflayer from 'mineflayer'
import pkg from 'mineflayer-pathfinder'
import armorManager from 'mineflayer-armor-manager'
import { loader as autoEat } from 'mineflayer-auto-eat'
import { plugin as pvp } from 'mineflayer-pvp'
import { plugin as collectBlock } from 'mineflayer-collectblock'

const { pathfinder, Movements, goals } = pkg
const { GoalNear } = goals

const bot = mineflayer.createBot({
  host: 'mc.victalejo.dev',
  port: 25565,
  username: 'fulltest',
  auth: 'offline',
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(armorManager)
bot.loadPlugin(autoEat)
bot.loadPlugin(pvp)
bot.loadPlugin(collectBlock)

bot.on('login', () => console.log('[F] logged in'))
bot.once('spawn', () => {
  console.log(`[F] spawned at ${bot.entity.position}`)
  setTimeout(() => bot.chat('jugar123'), 1500)

  const interval = setInterval(() => {
    const p = bot.entity?.position
    const valid = p && Number.isFinite(p.x)
    console.log(`[F] pos=(${p?.x},${p?.y},${p?.z}) valid=${valid}`)
  }, 1000)

  setTimeout(() => {
    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)
    const p = bot.entity.position
    console.log(`[F] before setGoal pos=(${p.x},${p.y},${p.z})`)
    const goal = new GoalNear(Math.floor(p.x) + 10, Math.floor(p.y), Math.floor(p.z), 2)
    bot.pathfinder.setGoal(goal)
    console.log(`[F] setGoal done, goal=${bot.pathfinder.goal != null} isMoving=${bot.pathfinder.isMoving()}`)
  }, 6000)

  bot.on('path_update', (r) => console.log(`[F] path_update status=${r.status} pathLen=${r.path?.length}`))
  bot.on('goal_reached', () => console.log('[F] GOAL REACHED'))

  setTimeout(() => { clearInterval(interval); console.log('[F] FINAL pos=', bot.entity?.position); bot.end() }, 25000)
})
bot.on('error', (e) => console.log('[F] err:', e.message))
bot.on('kicked', (r) => console.log('[F] kicked:', r))
bot.on('end', (r) => { console.log('[F] end:', r); process.exit(0) })
setTimeout(() => process.exit(1), 60000)
