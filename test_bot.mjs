import mineflayer from 'mineflayer'

const bot = mineflayer.createBot({
  host: 'mc.victalejo.dev',
  port: 25565,
  username: 'tester_pf',
  auth: 'offline',
})

bot.on('login', () => console.log('[T] logged in'))
bot.on('spawn', async () => {
  console.log('[T] spawned')
  setTimeout(() => bot.chat('jugar123'), 1500)
  setTimeout(() => {
    console.log('[T] sending: kevin sigueme a VictorAlejo')
    bot.chat('kevin sigueme a VictorAlejo')
  }, 4000)
  setTimeout(() => { console.log('[T] done'); bot.end() }, 30000)
})
bot.on('error', (e) => console.log('[T] err:', e.message))
bot.on('kicked', (r) => console.log('[T] kicked:', r))
bot.on('end', (r) => { console.log('[T] end:', r); process.exit(0) })
bot.on('chat', (u, m) => { if (u !== 'tester_pf') console.log(`[T] <${u}> ${m}`) })

setTimeout(() => { console.log('[T] timeout'); process.exit(1) }, 60000)
