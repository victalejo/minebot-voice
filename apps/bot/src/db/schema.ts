import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  player: text('player').notNull(),
  command: text('command').notNull(),
  understood: text('understood').notNull(),
  actions: text('actions').notNull(), // JSON stringified BotAction[]
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// TODO(multi-bot): cuando soportemos varios bots, esta tabla pasa a tener
// múltiples filas con columnas: name, host, port, username.
export const botConfig = sqliteTable('bot_config', {
  id: integer('id').primaryKey(),                  // singleton: siempre 1
  desiredState: text('desired_state').notNull(),   // 'connected' | 'disconnected'
  updatedAt: integer('updated_at').notNull(),      // unix ms
})

// Named locations the bot remembers (base, chests, etc.). Name is unique so
// "base" can be re-assigned by upserting on conflict.
export const locations = sqliteTable('locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),  // 'base' | 'chest' | 'bed' | 'other'
  x: integer('x').notNull(),
  y: integer('y').notNull(),
  z: integer('z').notNull(),
  createdAt: integer('created_at').notNull(),  // unix ms
})

// Autonomous goals queue. status transitions: pending -> active -> completed/failed/cancelled.
export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),                  // 'gather' | 'free_text'
  resource: text('resource'),                    // 'wood' | 'food' | 'stone' | null
  targetCount: integer('target_count'),          // null for free_text
  description: text('description').notNull(),
  status: text('status').notNull(),              // GoalStatus
  createdAt: integer('created_at').notNull(),    // unix ms
  startedAt: integer('started_at'),              // unix ms or null
  completedAt: integer('completed_at'),          // unix ms or null
  error: text('error'),                          // failure reason or null
})
