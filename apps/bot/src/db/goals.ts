import { and, asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { GatherResource, Goal, GoalStatus } from '@minebot/shared'
import { goals } from './schema.js'
import type * as schema from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

export interface GoalRow {
  id: number
  kind: string
  resource: string | null
  targetCount: number | null
  description: string
  status: string
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  error: string | null
}

export interface InsertGoalInput {
  kind: 'gather' | 'free_text'
  resource: GatherResource | null
  targetCount: number | null
  description: string
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    kind: row.kind as Goal['kind'],
    resource: row.resource as GatherResource | null,
    targetCount: row.targetCount,
    description: row.description,
    status: row.status as GoalStatus,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
  }
}

export function insertGoal(db: Db, input: InsertGoalInput): Goal {
  const now = Date.now()
  const result = db
    .insert(goals)
    .values({
      kind: input.kind,
      resource: input.resource,
      targetCount: input.targetCount,
      description: input.description,
      status: 'pending',
      createdAt: now,
    })
    .returning()
    .get()
  return rowToGoal(result as GoalRow)
}

export function getActiveGoal(db: Db): Goal | null {
  const row = db.select().from(goals).where(eq(goals.status, 'active')).get()
  return row ? rowToGoal(row as GoalRow) : null
}

// Oldest pending goal first. The manager calls this to pick what to run next.
export function getNextPendingGoal(db: Db): Goal | null {
  const row = db
    .select()
    .from(goals)
    .where(eq(goals.status, 'pending'))
    .orderBy(asc(goals.createdAt), asc(goals.id))
    .get()
  return row ? rowToGoal(row as GoalRow) : null
}

export function markGoalActive(db: Db, id: number): void {
  db.update(goals)
    .set({ status: 'active', startedAt: Date.now() })
    .where(eq(goals.id, id))
    .run()
}

export function markGoalCompleted(db: Db, id: number): void {
  db.update(goals)
    .set({ status: 'completed', completedAt: Date.now() })
    .where(eq(goals.id, id))
    .run()
}

export function markGoalFailed(db: Db, id: number, error: string): void {
  db.update(goals)
    .set({ status: 'failed', completedAt: Date.now(), error })
    .where(eq(goals.id, id))
    .run()
}

// Cancel everything that's not already terminal. Used when the user issues
// a manual override or cancelGoal action.
export function cancelAllGoals(db: Db): void {
  db.update(goals)
    .set({ status: 'cancelled', completedAt: Date.now() })
    .where(inArray(goals.status, ['pending', 'active']))
    .run()
}

export function listRecentGoals(db: Db, limit: number = 20): Goal[] {
  const rows = db
    .select()
    .from(goals)
    .orderBy(asc(goals.createdAt))
    .limit(limit)
    .all()
  return (rows as GoalRow[]).map(rowToGoal)
}

// On bot restart we don't want orphan "active" goals left behind. Reset them.
export function resetActiveGoals(db: Db): void {
  db.update(goals)
    .set({ status: 'pending', startedAt: null })
    .where(eq(goals.status, 'active'))
    .run()
}
