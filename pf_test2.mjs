import mineflayer from 'mineflayer'
import pkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pkg
const { GoalFollow } = goals

const bot = mineflayer.createBot({
  host: 'mc.victalejo.dev',
  port: 25565,
  username: 'pf_tester2',
  auth: 'offline',
})

bot.loadPlugin(pathfinder)

bot.on('login', () => console.log('[PFT2] logged in'))
bot.on('path_update', (r) => console.log(`[PFT2] path_update status=${r.status} cost=${r.cost} path=${r.path?.length}`))
bot.on('goal_reached', () => console.log('[PFT2] GOAL REACHED'))
bot.on('path_reset', (r) => console.log(`[PFT2] path_reset ${r}`))

let tickCount = 0
bot.on('physicsTick', () => {
  tickCount++
  if (tickCount % 40 === 0) {
    const p = bot.entity?.position
    console.log(`[PFT2] tick #${tickCount} pos=(${p?.x.toFixed(1)},${p?.y.toFixed(1)},${p?.z.toFixed(1)}) isMoving=${bot.pathfinder.isMoving()}`)
  }
})

bot.once('spawn', async () => {
  console.log(`[PFT2] spawned at ${bot.entity.position}`)
  setTimeout(() => bot.chat('jugar123'), 1500)

  setTimeout(() => {
    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)
    console.log('[PFT2] movements set')

    // Follow kevin since VictorAlejo is offline
    const target = bot.players['kevin']?.entity
    if (!target) { console.log('[PFT2] kevin not visible'); bot.end(); return }
    console.log(`[PFT2] kevin at ${target.position}, dist=${target.position.distanceTo(bot.entity.position).toFixed(1)}`)
    const goal = new GoalFollow(target, 3)
    bot.pathfinder.setGoal(goal, true)
    console.log(`[PFT2] after setGoal: isMoving=${bot.pathfinder.isMoving()} goal=${bot.pathfinder.goal != null}`)
  }, 5000)

  setTimeout(() => {
    console.log(`[PFT2] FINAL pos=${bot.entity.position}`)
    bot.end()
  }, 40000)
})

bot.on('kicked', (r) => console.log('[PFT2] kicked:', r))
bot.on('error', (e) => console.log('[PFT2] err:', e.message))
bot.on('end', (r) => { console.log('[PFT2] end:', r); process.exit(0) })
setTimeout(() => { console.log('[PFT2] TIMEOUT'); process.exit(1) }, 90000)
