import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { locations } from './schema.js'
import type * as schema from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

export interface LocationRow {
  id: number
  name: string
  kind: string
  x: number
  y: number
  z: number
  createdAt: number
}

export interface LocationInput {
  name: string
  kind: string
  x: number
  y: number
  z: number
}

// Upsert by name. Re-assigning "base" overwrites the previous row.
export function setLocation(db: Db, input: LocationInput): void {
  const now = Date.now()
  db.insert(locations)
    .values({ ...input, createdAt: now })
    .onConflictDoUpdate({
      target: locations.name,
      set: { kind: input.kind, x: input.x, y: input.y, z: input.z, createdAt: now },
    })
    .run()
}

export function getLocation(db: Db, name: string): LocationRow | null {
  const row = db
    .select()
    .from(locations)
    .where(eq(locations.name, name))
    .get()
  return row ?? null
}

export function deleteLocation(db: Db, name: string): void {
  db.delete(locations).where(eq(locations.name, name)).run()
}

export function listLocations(db: Db): LocationRow[] {
  return db.select().from(locations).all()
}

// Format saved locations for inclusion in an AI prompt. Returns "" when empty.
export function formatLocationsForPrompt(db: Db): string {
  const rows = listLocations(db)
  if (rows.length === 0) return ''
  return rows
    .map((r) => `- ${r.name} (kind=${r.kind}): x=${r.x}, y=${r.y}, z=${r.z}`)
    .join('\n')
}
