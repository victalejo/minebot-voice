import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import type { ServerToClientEvents, ClientToServerEvents } from '@minebot/shared'
import { authRouter, verifyToken } from './auth.js'
import { connectBot, setLifecycleWirer } from './bot/index.js'
import { setupSocketBridge } from './socket/events.js'
import { getDb } from './db/index.js'
import { getDesiredState } from './db/bot-config.js'

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : []

const app = express()
const server = createServer(app)

export const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
  },
})

app.use(helmet({
  contentSecurityPolicy: false,
}))

app.get('/api/health', (_req, res) => { res.json({ ok: true }) })
app.use(express.json({ limit: '16kb' }))

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

app.use('/api/login', loginLimiter)
app.use(authRouter())

getDb() // Initialize database on startup

// Serve frontend static files in production
const __dirname = dirname(fileURLToPath(import.meta.url))
const webDist = join(__dirname, '../../web/dist')
app.use(express.static(webDist))
app.use((_req, res, next) => {
  if (_req.path.startsWith('/api') || _req.path.startsWith('/socket.io')) return next()
  res.sendFile(join(webDist, 'index.html'))
})

// Socket.io auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token as string
  if (!token || !verifyToken(token)) {
    return next(new Error('Unauthorized'))
  }
  next()
})

// Wire up the socket ↔ bot event bridge
const { startBotListeners, stopBotListeners } = setupSocketBridge(io, wireBotLifecycleBroadcasts)

// Auto-reconnect creates a fresh bot bypassing requestConnect; register the
// wirer so that path re-attaches the spawn/end/kicked broadcasters too.
setLifecycleWirer(wireBotLifecycleBroadcasts)

const PORT = Number(process.env.PORT) || 3001

function wireBotLifecycleBroadcasts(bot: ReturnType<typeof connectBot>): void {
  bot.on('spawn', () => {
    // stopBotListeners first to avoid duplicate listeners on reconnect
    stopBotListeners()
    startBotListeners(bot)
  })

  bot.on('end', () => {
    stopBotListeners()
    io.emit('bot:status', 'disconnected')
  })

  bot.on('kicked', () => {
    stopBotListeners()
    io.emit('bot:status', 'disconnected')
  })
}

server.listen(PORT, () => {
  console.log(`MineBot server running on port ${PORT}`)

  const host = process.env.MINECRAFT_HOST ?? 'localhost'
  const port = Number(process.env.MINECRAFT_PORT) || 25565
  const username = process.env.BOT_USERNAME ?? 'MineBot'
  const config = { host, port, username }

  // TODO(multi-bot): iterar todos los bots guardados, arrancando los que estan 'connected'.
  const desired = getDesiredState(getDb())
  if (desired === 'disconnected') {
    console.log('[Bot] desiredState=disconnected at startup; waiting for user action')
    io.emit('bot:status', 'disconnected')
    return
  }

  const bot = connectBot(config)
  wireBotLifecycleBroadcasts(bot)
})

export { app, server }
