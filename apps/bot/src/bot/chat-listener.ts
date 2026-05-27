import type { Bot } from 'mineflayer'
import { handleNaturalCommand, type CommandHandlerDeps } from './command-handler.js'

// How long the same player must wait before issuing another in-game command.
const CHAT_COOLDOWN_MS = 3000

// Maximum chat message length we accept as a command. mineflayer caps chat
// at 256 characters server-side anyway, but cap explicitly to be safe.
const MAX_CHAT_LENGTH = 256

export interface ChatListenerHandle {
  stop: () => void
}

// Listen for in-game chat addressed to the bot by name and route those
// messages through the same natural-command pipeline used by the dashboard.
export function setupChatListener(
  bot: Bot,
  deps: CommandHandlerDeps,
  botName: string,
): ChatListenerHandle {
  const cooldowns = new Map<string, number>()
  const namePattern = buildMentionRegex(botName)

  console.log(`[Chat] Listening for mentions of "${botName}"`)

  const onChat = (username: string, message: string): void => {
    // Ignore our own messages so a "say" action doesn't echo into a command.
    if (username === bot.username) return
    if (!message || typeof message !== 'string') return
    if (message.length > MAX_CHAT_LENGTH) return

    const match = message.match(namePattern)
    if (!match) return
    const rest = match[1]?.trim()
    if (!rest) {
      // Just our name with nothing after — acknowledge briefly without
      // burning an AI call.
      bot.chat(`¿sí, ${username}?`)
      return
    }

    const now = Date.now()
    const last = cooldowns.get(username) ?? 0
    if (now - last < CHAT_COOLDOWN_MS) {
      bot.chat(`${username}, espera un momento`)
      return
    }
    cooldowns.set(username, now)

    // Fire and forget — handler manages its own error reporting via socket.
    void handleNaturalCommand(rest, username, deps).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Chat] Command handler crashed:', msg)
    })
  }

  bot.on('chat', onChat)

  return {
    stop: () => {
      bot.removeListener('chat', onChat)
    },
  }
}

// Build a case-insensitive regex that matches our name at the start of the
// message, optionally prefixed by "@", with optional separators, and captures
// the rest. Uses \b so "Juan" doesn't match "Juanito".
function buildMentionRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*@?${escaped}\\b[,:.\\-\\s]*(.*)$`, 'i')
}
