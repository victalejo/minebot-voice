import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources/messages'
import OpenAI from 'openai'
import { promises as fs } from 'fs'
import path from 'path'
import type { GatherResource } from '@minebot/shared'

// Reuse parser provider config so the same .env drives both.
const AI_PROVIDER = process.env.AI_PROVIDER ?? 'anthropic'

// Planner-specific overrides (default to parser model if not set).
// Use || not ?? so empty-string env vars (from docker-compose default expansion) also fall through.
const PLANNER_MODEL = process.env.PLANNER_MODEL || (
  AI_PROVIDER === 'openai'
    ? (process.env.AI_MODEL || 'deepseek-v4-pro')
    : (process.env.AI_MODEL || 'claude-sonnet-4-20250514')
)
const PLANNER_THINKING = (process.env.PLANNER_THINKING || process.env.OPENAI_THINKING || undefined) as
  | 'enabled' | 'disabled' | undefined
const PLANNER_REASONING_EFFORT = (
  process.env.PLANNER_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || undefined
) as 'low' | 'medium' | 'high' | 'max' | undefined

const anthropic = AI_PROVIDER === 'anthropic' ? new Anthropic() : null
const openai = AI_PROVIDER === 'openai'
  ? new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null

const OPENAI_JSON_MODE = (process.env.OPENAI_JSON_MODE ?? 'json_object') as
  | 'json_object' | 'json_schema'

const MEMORY_FILE = 'bot-memories.json'

// ── Public types ─────────────────────────────────────────────────────────────

export interface PlannerInput {
  health: number
  food: number
  position: { x: number; y: number; z: number }
  inventory: string[]
  timeOfDay: number
  hasBase: boolean
  baseDistance: number | null
  // Last few goals with outcome (most recent last).
  recentGoals: { description: string; status: string; error: string | null }[]
  // Pre-formatted list of saved landmarks (empty string if none).
  knownLocations: string
}

export interface PlannedGoal {
  resource: GatherResource
  count: number
  description: string
}

export interface PlannerResult {
  goal: PlannedGoal | null
  reasoning?: string
}

export interface PlannerOptions {
  memoryDir: string
}

// ── Prompt construction ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el cerebro estratégico de MineBot, un bot autónomo de Minecraft. Tu trabajo es decidir QUÉ HACER A CONTINUACIÓN cuando el bot está ocioso.

Tienes acceso a una memoria persistente. Úsala para recordar preferencias del jugador, ubicaciones importantes, o patrones que aprendiste. Si una meta reciente falló (ej. "no wood found"), no la repitas — busca otra.

## Reglas de planificación (prioridad descendente)
1. Sin madera (oak_log/spruce_log/etc) → wood.
2. Con madera pero sin comida y food<16 → food.
3. Con madera y comida pero sin piedra (cobblestone) → stone.
4. Sin armadura puesta NI piezas de armadura en inventario → armor (matar zombis/esqueletos para drops).
5. Con armadura de cuero o sin botas de hierro+ y tiene piedra → iron (minar mineral de hierro para mejor armadura/herramientas).
6. Con todo lo básico cubierto → descansa (goal=null).

## Cantidades razonables
- wood: 8-32
- food: 4-12
- stone: 16-32
- armor: 1-4 (cada zombi/esqueleto tiene baja probabilidad de drop, así que conseguir 4 es ambicioso pero útil)
- iron: 6-16

## Output
Devuelve UN objeto JSON RAW (sin markdown, sin texto adicional):
{
  "reasoning": "breve frase en español explicando por qué",
  "goal": { "resource": "wood"|"food"|"stone"|"armor"|"iron", "count": number, "description": "frase corta en español" }
}

O si NADA tiene sentido ahora mismo:
{
  "reasoning": "explicación",
  "goal": null
}`

function buildUserPrompt(input: PlannerInput): string {
  const inv = input.inventory.length > 0 ? input.inventory.join(', ') : 'vacío'
  const isNight = input.timeOfDay >= 13000 && input.timeOfDay <= 23000
  const timeStr = isNight ? 'noche' : 'día'
  const baseInfo = input.hasBase
    ? `sí, a ${input.baseDistance != null ? Math.round(input.baseDistance) : '?'}b`
    : 'no'

  let recent = 'ninguna'
  if (input.recentGoals.length > 0) {
    recent = input.recentGoals
      .map((g) => `- ${g.description} [${g.status}${g.error ? `: ${g.error}` : ''}]`)
      .join('\n')
  }

  const locations = input.knownLocations.length > 0
    ? `\n\n## Lugares guardados\n${input.knownLocations}`
    : ''

  return `## Estado actual
- HP: ${input.health}/20, Hambre: ${input.food}/20
- Posición: x=${input.position.x}, y=${input.position.y}, z=${input.position.z}
- Hora: ${timeStr} (timeOfDay=${input.timeOfDay})
- Base conocida: ${baseInfo}
- Inventario: ${inv}${locations}

## Metas recientes
${recent}

¿Cuál debe ser la próxima meta?`
}

// ── JSON schema for strict mode (OpenAI/MiniMax) ────────────────────────────

const PLAN_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    reasoning: { type: 'string' as const },
    goal: {
      anyOf: [
        {
          type: 'object' as const,
          properties: {
            resource: { type: 'string' as const, enum: ['wood', 'food', 'stone'] },
            count: { type: 'number' as const },
            description: { type: 'string' as const },
          },
          required: ['resource', 'count', 'description'],
          additionalProperties: false,
        },
        { type: 'null' as const },
      ],
    },
  },
  required: ['goal'],
  additionalProperties: false,
}

// ── Memory tool (read/write/delete) — same shape as command-parser ──────────

const openaiMemoryToolDef: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'memory',
    description: 'Persistent memory: read all, write key/value, delete key.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'delete'] },
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['action'],
    },
  },
}

const anthropicMemoryToolDef = {
  name: 'memory',
  description: 'Persistent memory: read all, write key/value, delete key.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'delete'] },
      key: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['action'],
  },
}

async function handleMemoryTool(
  memoryDir: string,
  input: { action: string; key?: string; value?: string },
): Promise<string> {
  const filePath = path.join(memoryDir, MEMORY_FILE)
  let memories: Record<string, string> = {}
  try {
    memories = JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch { /* fresh */ }

  switch (input.action) {
    case 'read': {
      const entries = Object.entries(memories)
      if (entries.length === 0) return 'No memories stored yet.'
      return entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')
    }
    case 'write': {
      if (!input.key || !input.value) return 'Error: key and value required.'
      memories[input.key] = input.value
      await fs.mkdir(memoryDir, { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(memories, null, 2))
      return `Saved: ${input.key}`
    }
    case 'delete': {
      if (!input.key) return 'Error: key required.'
      if (!(input.key in memories)) return `Key "${input.key}" not found.`
      delete memories[input.key]
      await fs.writeFile(filePath, JSON.stringify(memories, null, 2))
      return `Deleted: ${input.key}`
    }
    default: return `Unknown action: ${input.action}`
  }
}

// ── Response parsing ────────────────────────────────────────────────────────

function extractJSON(raw: string): string {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

function parsePlannerResponse(raw: string): PlannerResult {
  try {
    const parsed = JSON.parse(extractJSON(raw)) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return { goal: null, reasoning: 'invalid response shape' }
    }
    const obj = parsed as { reasoning?: unknown; goal?: unknown }
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : undefined

    if (obj.goal === null || obj.goal === undefined) {
      return { goal: null, reasoning }
    }

    if (typeof obj.goal !== 'object') {
      return { goal: null, reasoning: 'goal is not an object' }
    }

    const g = obj.goal as { resource?: unknown; count?: unknown; description?: unknown }
    if (
      (g.resource === 'wood' || g.resource === 'food' || g.resource === 'stone') &&
      typeof g.count === 'number' && g.count > 0 &&
      typeof g.description === 'string'
    ) {
      return {
        reasoning,
        goal: {
          resource: g.resource,
          count: Math.min(Math.floor(g.count), 64), // clamp to sane range
          description: g.description,
        },
      }
    }
    return { goal: null, reasoning: 'goal failed validation' }
  } catch (err) {
    console.error('[Planner] JSON parse failed:', err)
    return { goal: null, reasoning: 'JSON parse failed' }
  }
}

// ── OpenAI provider ─────────────────────────────────────────────────────────

async function planOpenAI(
  userPrompt: string,
  memoryDir: string,
): Promise<PlannerResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]

  const responseFormat: OpenAI.ChatCompletionCreateParams['response_format'] =
    OPENAI_JSON_MODE === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: { name: 'planner_response', strict: true, schema: PLAN_RESPONSE_SCHEMA },
        }
      : { type: 'json_object' }

  const extraBody = PLANNER_THINKING
    ? { thinking: { type: PLANNER_THINKING } }
    : undefined

  for (let i = 0; i < 5; i++) {
    const response = await openai!.chat.completions.create({
      model: PLANNER_MODEL,
      max_tokens: 2048,  // thinking mode needs headroom
      messages,
      tools: [openaiMemoryToolDef],
      response_format: responseFormat,
      ...(PLANNER_REASONING_EFFORT && { reasoning_effort: PLANNER_REASONING_EFFORT }),
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
    console.log('[Planner] Raw response:', raw.slice(0, 300))
    return parsePlannerResponse(raw)
  }

  return { goal: null, reasoning: 'exceeded tool-call rounds' }
}

// ── Anthropic provider ──────────────────────────────────────────────────────

async function planAnthropic(
  userPrompt: string,
  memoryDir: string,
): Promise<PlannerResult> {
  const messages: MessageParam[] = [{ role: 'user', content: userPrompt }]

  for (let i = 0; i < 5; i++) {
    const response = await anthropic!.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages,
      tools: [anthropicMemoryToolDef],
    })

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      messages.push({ role: 'assistant', content: response.content })
      const results = await Promise.all(
        toolBlocks.map(async (block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: await handleMemoryTool(
            memoryDir,
            block.input as { action: string; key?: string; value?: string },
          ),
        })),
      )
      messages.push({ role: 'user', content: results })
      continue
    }

    const textBlock = response.content.find((b) => b.type === 'text')
    const raw = textBlock?.type === 'text' ? textBlock.text : ''
    console.log('[Planner] Raw response:', raw.slice(0, 300))
    return parsePlannerResponse(raw)
  }

  return { goal: null, reasoning: 'exceeded tool-call rounds' }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function planNextGoal(
  input: PlannerInput,
  options: PlannerOptions,
): Promise<PlannerResult> {
  const userPrompt = buildUserPrompt(input)
  try {
    if (AI_PROVIDER === 'openai') {
      return await planOpenAI(userPrompt, options.memoryDir)
    }
    return await planAnthropic(userPrompt, options.memoryDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Planner] API call failed:', msg)
    return { goal: null, reasoning: `API error: ${msg.slice(0, 100)}` }
  }
}
