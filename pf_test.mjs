import mineflayer from 'mineflayer'
import pkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pkg
const { GoalNear, GoalFollow } = goals

const bot = mineflayer.createBot({
  host: 'mc.victalejo.dev',
  port: 25565,
  username: 'pf_tester',
  auth: 'offline',
})

bot.loadPlugin(pathfinder)

bot.on('login', () => console.log('[PFT] logged in'))
bot.on('path_update', (r) => console.log(`[PFT] path_update status=${r.status} cost=${r.cost} path=${r.path?.length}`))
bot.on('goal_reached', () => console.log('[PFT] GOAL REACHED'))
bot.on('path_reset', (r) => console.log(`[PFT] path_reset ${r}`))

let tickCount = 0
bot.on('physicsTick', () => {
  tickCount++
  if (tickCount % 40 === 0) {
    const p = bot.entity?.position
    console.log(`[PFT] tick #${tickCount} pos=(${p?.x.toFixed(1)},${p?.y.toFixed(1)},${p?.z.toFixed(1)}) isMoving=${bot.pathfinder.isMoving()}`)
  }
})

bot.once('spawn', async () => {
  console.log(`[PFT] spawned at ${bot.entity.position}`)
  setTimeout(() => bot.chat('jugar123'), 1500)

  setTimeout(() => {
    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)
    console.log('[PFT] movements set')

    // Test 1: simple GoalNear, 20 blocks away on X axis
    const p = bot.entity.position
    const target = { x: Math.floor(p.x + 20), y: Math.floor(p.y), z: Math.floor(p.z) }
    const goal = new GoalNear(target.x, target.y, target.z, 2)
    console.log(`[PFT] TEST: GoalNear (${target.x},${target.y},${target.z}) from (${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`)
    bot.pathfinder.setGoal(goal)
    console.log(`[PFT] after setGoal: isMoving=${bot.pathfinder.isMoving()} pathfinder.goal=${bot.pathfinder.goal != null}`)
  }, 5000)

  setTimeout(() => {
    console.log(`[PFT] FINAL pos=${bot.entity.position}`)
    bot.end()
  }, 30000)
})

bot.on('kicked', (r) => console.log('[PFT] kicked:', r))
bot.on('error', (e) => console.log('[PFT] err:', e.message))
bot.on('end', (r) => { console.log('[PFT] end:', r); process.exit(0) })
setTimeout(() => { console.log('[PFT] TIMEOUT'); process.exit(1) }, 60000)
