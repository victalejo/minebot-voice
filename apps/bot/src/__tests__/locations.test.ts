import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'
import {
  setLocation,
  getLocation,
  deleteLocation,
  listLocations,
  formatLocationsForPrompt,
} from '../db/locations.js'

function createTestDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  return drizzle(sqlite, { schema })
}

describe('locations', () => {
  let db: ReturnType<typeof createTestDb>

  beforeEach(() => {
    db = createTestDb()
  })

  it('setLocation inserts a new row when the name is fresh', () => {
    setLocation(db, { name: 'base', kind: 'base', x: 10, y: 64, z: -20 })
    const row = getLocation(db, 'base')
    expect(row).toMatchObject({ name: 'base', kind: 'base', x: 10, y: 64, z: -20 })
  })

  it('setLocation upserts when reusing a name (move the base)', () => {
    setLocation(db, { name: 'base', kind: 'base', x: 10, y: 64, z: -20 })
    setLocation(db, { name: 'base', kind: 'base', x: 100, y: 70, z: 200 })
    const row = getLocation(db, 'base')
    expect(row?.x).toBe(100)
    expect(row?.z).toBe(200)
    expect(listLocations(db)).toHaveLength(1)
  })

  it('getLocation returns null when missing', () => {
    expect(getLocation(db, 'nowhere')).toBeNull()
  })

  it('deleteLocation removes the row', () => {
    setLocation(db, { name: 'spot', kind: 'other', x: 1, y: 2, z: 3 })
    deleteLocation(db, 'spot')
    expect(getLocation(db, 'spot')).toBeNull()
  })

  it('formatLocationsForPrompt produces a multiline listing', () => {
    setLocation(db, { name: 'base', kind: 'base', x: 0, y: 64, z: 0 })
    setLocation(db, { name: 'chest_1', kind: 'chest', x: 5, y: 64, z: 5 })
    const formatted = formatLocationsForPrompt(db)
    expect(formatted).toContain('base (kind=base): x=0, y=64, z=0')
    expect(formatted).toContain('chest_1 (kind=chest): x=5, y=64, z=5')
  })

  it('formatLocationsForPrompt returns empty string when no rows', () => {
    expect(formatLocationsForPrompt(db)).toBe('')
  })
})
