import type { Bot } from 'mineflayer'
import { handleNaturalCommand, type CommandHandlerDeps } from './command-handler.js'

// Per-player and global throttles so a busy chat doesn't drown the AI in calls.
const PLAYER_COOLDOWN_MS = 2500
const GLOBAL_COOLDOWN_MS = 1200
const MAX_CHAT_LENGTH = 256
const MIN_CHAT_LENGTH = 2

export interface ChatListenerHandle {
  stop: () => void
}

// Route every in-game chat message through the AI, which decides whether the
// message warrants a response (own name mentioned, general question, social
// greeting, ...) or should be ignored (two other players talking, short
// acknowledgments, auth passwords). The AI returns empty actions to stay silent.
export function setupChatListener(
  bot: Bot,
  deps: CommandHandlerDeps,
  botName: string,
): ChatListenerHandle {
  const cooldowns = new Map<string, number>()
  let lastGlobal = 0
  const authPassword = process.env.MC_AUTH_PASSWORD?.trim()

  console.log(`[Chat] Listening as "${botName}" — AI judges every message`)

  const onChat = (username: string, message: string): void => {
    if (username === bot.username) return
    if (!message || typeof message !== 'string') return

    const msg = message.trim()
    if (msg.length < MIN_CHAT_LENGTH || msg.length > MAX_CHAT_LENGTH) return
    if (authPassword && msg === authPassword) return  // someone else's login attempt
    if (msg.startsWith('/')) return  // server command echo

    const now = Date.now()
    if (now - lastGlobal < GLOBAL_COOLDOWN_MS) return  // global rate limit, silent
    const last = cooldowns.get(username) ?? 0
    if (now - last < PLAYER_COOLDOWN_MS) return  // per-player rate limit, silent

    cooldowns.set(username, now)
    lastGlobal = now

    void handleNaturalCommand(msg, username, deps, 'chat').catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('[Chat] Command handler crashed:', errMsg)
    })
  }

  bot.on('chat', onChat)

  return {
    stop: () => {
      bot.removeListener('chat', onChat)
    },
  }
}
