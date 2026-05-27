import { describe, it, expect } from 'vitest'

// Inline copy of the regex builder for unit testing — keeps the chat-listener
// module from needing to export internals.
function buildMentionRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*@?${escaped}\\b[,:.\\-\\s]*(.*)$`, 'i')
}

describe('chat mention regex', () => {
  const re = buildMentionRegex('Juan')

  it('matches "Juan, ven aquí" capturing "ven aquí"', () => {
    expect('Juan, ven aquí'.match(re)?.[1]).toBe('ven aquí')
  })

  it('matches "juan: consigue madera" (case-insensitive)', () => {
    expect('juan: consigue madera'.match(re)?.[1]).toBe('consigue madera')
  })

  it('matches "@Juan haz X" with at-prefix', () => {
    expect('@Juan haz X'.match(re)?.[1]).toBe('haz X')
  })

  it('matches "Juan ven" with whitespace separator', () => {
    expect('Juan ven'.match(re)?.[1]).toBe('ven')
  })

  it('matches bare "Juan" and captures empty string', () => {
    expect('Juan'.match(re)?.[1]).toBe('')
  })

  it('does NOT match "hola Juan" — name must be at start', () => {
    expect('hola Juan'.match(re)).toBeNull()
  })

  it('does NOT match "Juanito" — word boundary required', () => {
    expect('Juanito'.match(re)).toBeNull()
  })

  it('handles names with regex metacharacters safely', () => {
    const re2 = buildMentionRegex('Bot.Pro')
    expect('Bot.Pro: hola'.match(re2)?.[1]).toBe('hola')
    // The escape ensures "BotXPro" doesn't match (the "." would otherwise be wildcard).
    expect('BotXPro: hola'.match(re2)).toBeNull()
  })
})
