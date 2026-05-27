import mineflayer from 'mineflayer'

const bot = mineflayer.createBot({
  host: 'mc.victalejo.dev',
  port: 25565,
  username: 'target_bot',
  auth: 'offline',
})

bot.on('login', () => console.log('[TGT] logged in'))
bot.on('spawn', async () => {
  console.log(`[TGT] spawned at ${bot.entity.position}`)
  setTimeout(() => bot.chat('jugar123'), 1500)
  setTimeout(() => {
    console.log('[TGT] sending kevin follow command')
    bot.chat('kevin sigueme')
  }, 4500)
  // Stay alive for 60s
  setTimeout(() => { console.log('[TGT] done'); bot.end() }, 65000)
})
bot.on('error', (e) => console.log('[TGT] err:', e.message))
bot.on('kicked', (r) => console.log('[TGT] kicked:', r))
bot.on('end', (r) => { console.log('[TGT] end:', r); process.exit(0) })
setTimeout(() => process.exit(1), 90000)
