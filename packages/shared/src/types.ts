// Bot state for the autonomous state machine.
// Priority (highest first):
//   fleeing           — HP critical, escaping
//   defending         — engaging a hostile mob
//   sleeping          — using a bed
//   executing_command — running a user-issued command
//   returning_home    — navigating back to base
//   gathering         — pursuing an active goal (e.g. collect wood)
//   idle              — no active goal
export type BotState =
  | 'fleeing'
  | 'defending'
  | 'sleeping'
  | 'executing_command'
  | 'returning_home'
  | 'gathering'
  | 'idle'

// Kinds of resources the bot can gather as a goal.
export type GatherResource = 'wood' | 'food' | 'stone'

// Goal lifecycle status (mirrors DB column).
export type GoalStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled'

// A goal as exposed to the dashboard / API.
export interface Goal {
  id: number
  kind: 'gather' | 'free_text'
  resource: GatherResource | null   // null when kind === 'free_text'
  targetCount: number | null        // null when kind === 'free_text'
  description: string
  status: GoalStatus
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  error: string | null
}

// Connection status
export type BotStatus = 'connecting' | 'connected' | 'disconnected' | 'dead'

// Stats sent every 1s from server to client
export interface BotStats {
  health: number
  food: number
  xp: { level: number; progress: number }
  position: { x: number; y: number; z: number }
  state: BotState
  timeOfDay: number
  isRaining: boolean
  // Current high-level goal driving autonomous behavior. Null when idle/no goal.
  currentGoal: string | null
}

// Single inventory item
export interface InventoryItem {
  slot: number
  name: string
  displayName: string
  count: number
}

// Activity feed entry
export interface ActivityEvent {
  id: string
  timestamp: number
  type: 'danger' | 'command' | 'action' | 'info'
  message: string
}

// Voice command from client
export interface VoiceCommand {
  text: string
  timestamp: number
}

// Claude's parsed response
export interface CommandResponse {
  understood: string
  actions: BotAction[]
}

// All possible bot actions (fixed schema, Claude picks from these)
export type BotAction =
  | { action: 'moveTo'; x: number; y: number; z: number }
  | { action: 'mine'; block: string; count: number }
  | { action: 'digDown'; toY: number }
  | { action: 'follow'; player: string }
  | { action: 'attack'; entity: string }
  | { action: 'craft'; item: string }
  | { action: 'equipItem'; item: string; destination: string }
  | { action: 'dropItem'; item: string; count: number }
  | { action: 'stop' }
  | { action: 'say'; message: string }
  | { action: 'sleep' }
  // Long-running autonomous goal. The bot enqueues it and the goal manager
  // picks it up when no higher-priority state is active.
  | { action: 'setGoal'; resource: GatherResource; count: number; description?: string }
  // Cancel the currently active goal (and clear the pending queue).
  | { action: 'cancelGoal' }
  // Persist the bot's CURRENT position as a named landmark in DB.
  // kind: 'base' (main home), 'chest' (storage), 'bed' (sleep spot), or 'other'.
  | { action: 'rememberHere'; name: string; kind: 'base' | 'chest' | 'bed' | 'other' }
  // Walk to a previously-saved location by name.
  | { action: 'goToLocation'; name: string }
  // Forget a saved location.
  | { action: 'forgetLocation'; name: string }
  // Place a single block at world coords. block is the inventory item name
  // (e.g. "cobblestone", "oak_planks"). Best-effort — fails silently if the
  // bot can't reach or has no reference block.
  | { action: 'placeBlock'; block: string; x: number; y: number; z: number }
  // Build a 3×3×3 cobblestone shelter centered at the bot's current position,
  // with a 1-block door slot facing -X and a bed inside if available.
  | { action: 'buildShelter' }

// Socket.io typed events
export interface ServerToClientEvents {
  'bot:stats': (stats: BotStats) => void
  'bot:inventory': (items: InventoryItem[]) => void
  'bot:activity': (event: ActivityEvent) => void
  'bot:status': (status: BotStatus) => void
  'command:response': (response: CommandResponse) => void
  'bot:goal': (goal: Goal | null) => void
}

export interface ClientToServerEvents {
  'voice:command': (command: VoiceCommand) => void
  // TODO(multi-bot): estos eventos recibirán { botId: string } en el futuro
  'bot:connect': () => void
  'bot:disconnect': () => void
}

// Auth
export interface LoginRequest {
  password: string
}

export interface LoginResponse {
  token: string
}
