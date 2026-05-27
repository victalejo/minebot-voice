import Anthropic from '@anthropic-ai/sdk'
import type { Tool, MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources/messages'
import OpenAI from 'openai'
import { promises as fs } from 'fs'
import path from 'path'
import type { CommandResponse, BotAction } from '@minebot/shared'

// Provider selection via env: "openai" or "anthropic" (default)
const AI_PROVIDER = process.env.AI_PROVIDER ?? 'anthropic'

const anthropic = AI_PROVIDER === 'anthropic' ? new Anthropic() : null
const openai = AI_PROVIDER === 'openai'
  ? new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null

const AI_MODEL = process.env.AI_MODEL ?? (
  AI_PROVIDER === 'openai' ? 'deepseek-v4-flash' : 'claude-sonnet-4-20250514'
)

// json_schema (strict): OpenAI, MiniMax. json_object: DeepSeek and most others.
const OPENAI_JSON_MODE = (process.env.OPENAI_JSON_MODE ?? 'json_object') as
  | 'json_object'
  | 'json_schema'

// DeepSeek V4 Pro thinking mode. Ignored by Flash and other providers.
// Values: 'enabled' | 'disabled' | undefined (omit param entirely).
const OPENAI_THINKING = process.env.OPENAI_THINKING as
  | 'enabled'
  | 'disabled'
  | undefined
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT as
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | undefined

export interface BotContext {
  health: number
  food: number
  position: { x: number; y: number; z: number }
  inventory: string[]
  timeOfDay: number
  isRaining: boolean
  // Pre-formatted multi-line listing of saved locations ("- base (kind=base): x=... y=... z=...").
  // Empty string if none.
  knownLocations?: string
}

export const ACTION_SCHEMA = `
Available actions (respond with exactly these JSON shapes):

1. moveTo: { "action": "moveTo", "x": number, "y": number, "z": number }
2. mine: { "action": "mine", "block": string, "count": number }
   - block must be the Minecraft block ID (e.g. "diamond_ore", "stone", "oak_log")
   - Use for small, specific quantities. For "consigue 20 madera" prefer setGoal.
3. digDown: { "action": "digDown", "toY": number }
   - toY is the Y coordinate to dig down to (diamond level is around -59)
4. follow: { "action": "follow", "player": string }
5. attack: { "action": "attack", "entity": string }
   - entity is the mob type (e.g. "zombie", "skeleton", "cow")
6. craft: { "action": "craft", "item": string }
   - item must be the Minecraft item ID (e.g. "crafting_table", "wooden_pickaxe", "stone_axe")
7. equipItem: { "action": "equipItem", "item": string, "destination": string }
   - destination: "hand", "off-hand", "head", "torso", "legs", "feet"
8. dropItem: { "action": "dropItem", "item": string, "count": number }
9. stop: { "action": "stop" }
10. say: { "action": "say", "message": string }
11. sleep: { "action": "sleep" }
12. setGoal: { "action": "setGoal", "resource": "wood"|"food"|"stone", "count": number, "description": string }
    - Use for long-running autonomous tasks ("consigue madera", "junta comida")
    - The bot will pursue this goal in the background while still surviving (eating, fleeing, etc).
    - description is a short Spanish phrase shown to the user.
13. cancelGoal: { "action": "cancelGoal" }
    - Cancels the current goal and clears the queue. Use when the user says "para", "cancela", "olvídalo".
14. rememberHere: { "action": "rememberHere", "name": string, "kind": "base"|"chest"|"bed"|"other" }
    - Saves the bot's CURRENT position with a name. Use when the user says "aquí es mi base", "marca este cofre", etc.
    - Suggested names: "base" for the main home, "chest_X" or descriptive names for storage, "spawn" for spawn point.
    - Re-using a name overwrites the previous coords (used to update the base when you move).
15. goToLocation: { "action": "goToLocation", "name": string }
    - Walks to a previously-saved location by name. Use for "ve a la base", "regresa al cofre", etc.
    - Saved locations are listed in "Saved locations" section of the prompt — use those names exactly.
16. forgetLocation: { "action": "forgetLocation", "name": string }
    - Deletes a saved location. Use when the user says "olvida la base", "borra X".
`.trim()

const SYSTEM_PROMPT = `You are MineBot, an expert Minecraft bot that translates natural language commands into action sequences. You are resourceful, smart, and always find a way to fulfill requests.

## Memory
You have a persistent memory system. Use it to remember important facts players tell you:
- Player base locations, favorite items, preferences
- Instructions like "never mine my diamonds" or "my base is at 100 64 200"
- Anything a player asks you to remember
Check your memory when a command might need recalled information (locations, preferences, past instructions).
Do NOT check memory for simple, self-contained commands like "mina 10 piedra" or "ven aqui".

## Rules
- ALWAYS respond with a raw JSON object. No markdown, no code fences, no plain text. NEVER respond with anything other than JSON.
- The "understood" field must be a brief Spanish sentence describing what you'll do.
- Think about prerequisites: if the user asks for stone axes, you need a crafting_table first, then planks, sticks, etc.
- Use correct Minecraft block/item IDs (snake_case): oak_log, cobblestone, stone_axe, wooden_pickaxe, crafting_table, stick, oak_planks
- When the user says "madera" they usually mean oak_log. "piedra" = cobblestone for crafting.
- For crafting tools, remember recipes: stone_axe needs 3 cobblestone + 2 sticks. wooden_pickaxe needs 3 oak_planks + 2 sticks.
- You can chain many actions. Be thorough - complete the full request in one response.
- If a command is ambiguous, make reasonable assumptions and execute.
- If the user says something casual ("hola", "que haces"), respond with a say action.
- If you CANNOT fulfill a request (missing materials, impossible task), use a "say" action to explain why. NEVER respond with plain text.

## Goals vs immediate actions
- "Consigue/junta/recolecta N madera|comida|piedra" → use setGoal with resource and count. The bot pursues it autonomously (will eat, defend itself, sleep while gathering).
- "Mina 5 piedra aquí" (small, immediate) → use mine.
- "Para/cancela/olvídalo" → use cancelGoal (then optionally a say to confirm).
- A setGoal does NOT need to be combined with mine/attack — the goal handles its own gathering loop.

## Locations
- "Aquí es mi base" / "marca esto como base" → rememberHere with name="base" kind="base"
- "Marca este cofre" → rememberHere with name like "cofre_principal" kind="chest"
- "Ve a la base" / "regresa" → goToLocation with name="base"
- "Olvida la base" → forgetLocation with name="base"
- Check the "Saved locations" section to know what's already saved before using a name.

## Response format (MANDATORY — every response must be exactly this shape)
{"understood": "<Spanish description>", "actions": [...]}
`

const COMMAND_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    understood: { type: 'string' as const },
    actions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          action: { type: 'string' as const },
          x: { type: 'number' as const },
          y: { type: 'number' as const },
          z: { type: 'number' as const },
          block: { type: 'string' as const },
          count: { type: 'number' as const },
          toY: { type: 'number' as const },
          player: { type: 'string' as const },
          entity: { type: 'string' as const },
          item: { type: 'string' as const },
          destination: { type: 'string' as const },
          message: { type: 'string' as const },
          resource: { type: 'string' as const },
          description: { type: 'string' as const },
          name: { type: 'string' as const },
          kind: { type: 'string' as const },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  required: ['understood', 'actions'],
  additionalProperties: false,
}

export function buildPrompt(command: string, ctx: BotContext, historyContext?: string): string {
  const inventoryStr =
    ctx.inventory.length > 0 ? ctx.inventory.join(', ') : 'vacio'

  const timeStr = ctx.timeOfDay >= 13000 && ctx.timeOfDay <= 23000 ? 'noche' : 'dia'

  let prompt = `## Bot state
- Health: ${ctx.health}/20, Food: ${ctx.food}/20
- Position: x=${ctx.position.x}, y=${ctx.position.y}, z=${ctx.position.z}
- Time: ${timeStr}${ctx.isRaining ? ', lloviendo' : ''}
- Inventory: ${inventoryStr}`

  if (ctx.knownLocations && ctx.knownLocations.length > 0) {
    prompt += `\n\n## Saved locations\n${ctx.knownLocations}`
  }

  if (historyContext) {
    prompt += `\n\n## Recent conversation\n${historyContext}`
  }

  prompt += `\n\n## Actions\n${ACTION_SCHEMA}\n\n## Command\n${command}`

  return prompt
}

function extractJSON(raw: string): string {
  const trimmed = raw.trim()

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)

  return trimmed
}

export function parseResponse(raw: string): CommandResponse {
  const jsonStr = extractJSON(raw)

  try {
    const parsed = JSON.parse(jsonStr) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'understood' in parsed &&
      'actions' in parsed &&
      typeof (parsed as any).understood === 'string' &&
      Array.isArray((parsed as any).actions)
    ) {
      return {
        understood: (parsed as any).understood as string,
        actions: (parsed as any).actions as BotAction[],
      }
    }
    console.error('[AI] Unexpected response shape:', jsonStr.slice(0, 200))
    return {
      understood: 'Respuesta inesperada del modelo. Intenta de nuevo.',
      actions: [],
    }
  } catch (err) {
    console.error('[AI] Failed to parse JSON:', jsonStr.slice(0, 200), err)
    return {
      understood: 'No pude procesar la respuesta. Intenta de nuevo.',
      actions: [],
    }
  }
}

export interface ParseCommandOptions {
  memoryDir: string
}

const MEMORY_FILE = 'bot-memories.json'

const memoryToolDef: Tool = {
  name: 'memory',
  description:
    'Persistent memory for storing and retrieving information across conversations. Use "read" to check remembered facts, "write" to save new facts, "delete" to remove a fact.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'delete'],
        description: 'The memory operation to perform',
      },
      key: {
        type: 'string',
        description: 'Memory key (required for write/delete)',
      },
      value: {
        type: 'string',
        description: 'Value to store (required for write)',
      },
    },
    required: ['action'],
  },
}

const openaiMemoryToolDef: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'memory',
    description: memoryToolDef.description,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'delete'],
          description: 'The memory operation to perform',
        },
        key: { type: 'string', description: 'Memory key (required for write/delete)' },
        value: { type: 'string', description: 'Value to store (required for write)' },
      },
      required: ['action'],
    },
  },
}

async function loadMemories(memoryDir: string): Promise<Record<string, string>> {
  const filePath = path.join(memoryDir, MEMORY_FILE)
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function saveMemories(memoryDir: string, memories: Record<string, string>): Promise<void> {
  await fs.mkdir(memoryDir, { recursive: true })
  await fs.writeFile(path.join(memoryDir, MEMORY_FILE), JSON.stringify(memories, null, 2))
}

async function handleMemoryTool(
  memoryDir: string,
  input: { action: string; key?: string; value?: string },
): Promise<string> {
  const memories = await loadMemories(memoryDir)

  switch (input.action) {
    case 'read': {
      const keys = Object.keys(memories)
      if (keys.length === 0) return 'No memories stored yet.'
      return Object.entries(memories)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    }
    case 'write': {
      if (!input.key || !input.value) return 'Error: key and value are required for write.'
      memories[input.key] = input.value
      await saveMemories(memoryDir, memories)
      return `Saved: ${input.key} = ${input.value}`
    }
    case 'delete': {
      if (!input.key) return 'Error: key is required for delete.'
      if (!(input.key in memories)) return `Key "${input.key}" not found.`
      delete memories[input.key]
      await saveMemories(memoryDir, memories)
      return `Deleted: ${input.key}`
    }
    default:
      return `Unknown action: ${input.action}`
  }
}

// ── Anthropic provider ──

async function parseCommandAnthropic(
  prompt: string,
  memoryDir: string,
): Promise<CommandResponse> {
  const messages: MessageParam[] = [{ role: 'user', content: prompt }]

  for (let i = 0; i < 5; i++) {
    const response = await anthropic!.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      tools: [memoryToolDef],
    })

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      messages.push({ role: 'assistant', content: response.content })

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: await handleMemoryTool(
            memoryDir,
            block.input as { action: string; key?: string; value?: string },
          ),
        })),
      )
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    const textBlock = response.content.find((b) => b.type === 'text')
    const raw = textBlock?.type === 'text' ? textBlock.text : ''
    console.log('[AI] Raw response:', raw.slice(0, 300))
    return parseResponse(raw)
  }

  return { understood: 'Demasiadas iteraciones de memoria. Intenta de nuevo.', actions: [] }
}

// ── OpenAI provider (supports response_format for structured output) ──

async function parseCommandOpenAI(
  prompt: string,
  memoryDir: string,
): Promise<CommandResponse> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]

  const responseFormat: OpenAI.ChatCompletionCreateParams['response_format'] =
    OPENAI_JSON_MODE === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: {
            name: 'command_response',
            strict: true,
            schema: COMMAND_RESPONSE_SCHEMA,
          },
        }
      : { type: 'json_object' }

  // DeepSeek-specific extras (silently ignored by other providers via extra_body).
  const extraBody = OPENAI_THINKING
    ? { thinking: { type: OPENAI_THINKING } }
    : undefined

  for (let i = 0; i < 5; i++) {
    const response = await openai!.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 1024,
      messages,
      tools: [openaiMemoryToolDef],
      response_format: responseFormat,
      ...(OPENAI_REASONING_EFFORT && { reasoning_effort: OPENAI_REASONING_EFFORT }),
      ...(extraBody && { extra_body: extraBody }),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming)

    const choice = response.choices[0]
    const msg = choice.message

    if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
      messages.push(msg)
      for (const toolCall of msg.tool_calls) {
        if (toolCall.type !== 'function') continue
        const args = JSON.parse(toolCall.function.arguments) as {
          action: string; key?: string; value?: string
        }
        const result = await handleMemoryTool(memoryDir, args)
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
      }
      continue
    }

    const raw = msg.content ?? ''
    console.log('[AI] Raw response:', raw.slice(0, 300))

    // json_object isn't strict-schema, so use the tolerant parser as a safety net.
    return parseResponse(raw)
  }

  return { understood: 'Demasiadas iteraciones de memoria. Intenta de nuevo.', actions: [] }
}

// ── Public API ──

export async function parseCommand(
  command: string,
  ctx: BotContext,
  options: ParseCommandOptions,
  historyContext?: string,
): Promise<CommandResponse> {
  const prompt = buildPrompt(command, ctx, historyContext)

  try {
    if (AI_PROVIDER === 'openai') {
      return await parseCommandOpenAI(prompt, options.memoryDir)
    }
    return await parseCommandAnthropic(prompt, options.memoryDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[AI] API call failed:', msg)
    return {
      understood: `Error al contactar la IA: ${msg.slice(0, 100)}`,
      actions: [],
    }
  }
}
