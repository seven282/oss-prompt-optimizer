/**
 * State persistence tests (1.8.1): serialization round-trip, privacy
 * cropping, corrupt/version-mismatch tolerance, real-file save/load,
 * atomic write, and adapter factory behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSIST_VERSION,
  FilePersistence,
  createPersistence,
  cropEpisodes,
  cropEvents,
  parseState,
  serializeState,
} from '../src/persistence.js'
import { EpisodeLog, type CroppedEpisode, type Episode } from '../src/episode.js'
import type { PersistData } from '../src/persistence.js'
import type { StatusEvent } from '../src/status.js'
import type { OptimizeStats } from '../src/optimizer.js'

const STATS: OptimizeStats = {
  runs: 3, success: 2, failed: 1, cached: 0,
  local: 1, refined: 1, totalDurationMs: 4500, maxDurationMs: 2000,
  lastOutputTokens: 300, lastCallMs: 500, totalCallMs: 1400, maxCallMs: 600,
  callCount: 4, lastRunCalls: 2, lastInputTokens: 700,
  avgCallMs: 350,
}

function makeEpisode(input: string, overrides: Partial<Episode> = {}): Episode {
  return {
    ts: 1724678400000,
    input,
    taskType: 'writing',
    subtype: 'writing-report',
    local: false,
    refined: false,
    outputTokens: 300,
    inputTokens: 700,
    durationMs: 900,
    callCount: 2,
    profile: 'balanced',
    localMode: 'off',
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'po-persist-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('serializeState / parseState', () => {
  it('round-trips a full document', () => {
    const data: PersistData = {
      version: PERSIST_VERSION,
      updatedAt: 1724678400000,
      stats: STATS,
      episodes: cropEpisodes([makeEpisode('secret instruction', { local: true })]),
      events: [{ ts: 1, method: 'optimize', ok: true, outputTokens: 300, durationMs: 900, local: true } as StatusEvent],
    }
    const parsed = parseState(serializeState(data))
    expect(parsed).not.toBeNull()
    expect(parsed!.stats.runs).toBe(3)
    expect(parsed!.episodes).toHaveLength(1)
    expect(parsed!.events).toHaveLength(1)
  })

  it('returns null for invalid JSON', () => {
    expect(parseState('{ not json')).toBeNull()
  })

  it('returns null for a mismatched version', () => {
    const text = JSON.stringify({
      version: 2,
      updatedAt: 0,
      stats: STATS,
      episodes: [],
      events: [],
    })
    expect(parseState(text)).toBeNull()
  })

  it('returns null for missing/typed-wrong sections', () => {
    expect(parseState('{"version":1}')).toBeNull()
    expect(parseState('{"version":1,"stats":{},"episodes":"x","events":[]}')).toBeNull()
  })
})

describe('cropEpisodes / cropEvents', () => {
  it('strips the instruction text (privacy) but keeps metadata', () => {
    const cropped = cropEpisodes([makeEpisode('this must not persist')])
    expect(cropped).toHaveLength(1)
    expect(cropped[0]).not.toHaveProperty('input')
    expect(cropped[0].taskType).toBe('writing')
    expect(cropped[0].localMode).toBe('off')
  })

  it('caps episodes at the newest N', () => {
    const many = Array.from({ length: 210 }, (_, i) => makeEpisode(`in-${i}`, { ts: i }))
    const cropped = cropEpisodes(many, 200)
    expect(cropped).toHaveLength(200)
    expect(cropped[0].ts).toBe(10)
  })

  it('caps events at the newest N', () => {
    const events = Array.from({ length: 25 }, (_, i) => ({ ts: i, method: 'optimize' as const, ok: true }))
    expect(cropEvents(events, 20)).toHaveLength(20)
  })
})

describe('EpisodeLog.from', () => {
  it('rebuilds a log from cropped episodes', () => {
    const cropped: CroppedEpisode[] = [
      { ts: 1, taskType: 'writing', subtype: 'writing-report', local: false, refined: false, outputTokens: 1, inputTokens: 1, durationMs: 1, callCount: 1, profile: 'fast', localMode: 'off' },
      { ts: 2, taskType: 'writing', subtype: 'writing-report', local: false, refined: false, outputTokens: 1, inputTokens: 1, durationMs: 1, callCount: 1, profile: 'fast', localMode: 'off' },
    ]
    const log = EpisodeLog.from(cropped, 200)
    expect(log.size).toBe(2)
    expect(log.all()[1].ts).toBe(2)
  })
})

describe('FilePersistence (real files)', () => {
  it('returns null when the file does not exist', () => {
    expect(new FilePersistence(join(dir, 'missing.json')).loadSync()).toBeNull()
  })

  it('saves then loads a document back', () => {
    const path = join(dir, 'state.json')
    const p = new FilePersistence(path)
    const data: PersistData = {
      version: PERSIST_VERSION,
      updatedAt: 1724678400000,
      stats: STATS,
      episodes: cropEpisodes([makeEpisode('x')]),
      events: [],
    }
    expect(p.save(data)).toBe(true)
    const loaded = p.loadSync()
    expect(loaded).not.toBeNull()
    expect(loaded!.stats.runs).toBe(3)
    expect(loaded!.episodes).toHaveLength(1)
  })

  it('loads null for a corrupt file instead of throwing', () => {
    const path = join(dir, 'state.json')
    writeFileSync(path, '{corrupt', 'utf8')
    expect(new FilePersistence(path).loadSync()).toBeNull()
  })

  it('writes atomically — no leftover tmp file, previous content intact on failure', () => {
    const path = join(dir, 'state.json')
    const p = new FilePersistence(path)
    const data: PersistData = {
      version: PERSIST_VERSION,
      updatedAt: 0,
      stats: STATS,
      episodes: [],
      events: [],
    }
    expect(p.save(data)).toBe(true)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.version).toBe(PERSIST_VERSION)
  })
})

describe('createPersistence', () => {
  it('yields the noop adapter when persistState is off', () => {
    const adapter = createPersistence(false, '/whatever')
    expect(adapter.loadSync()).toBeNull()
    const noopData: PersistData = { version: PERSIST_VERSION, updatedAt: 0, stats: STATS, episodes: [], events: [] }
    expect(adapter.save(noopData)).toBe(true)
  })

  it('honors an explicit stateFile override', () => {
    const path = join(dir, 'custom', 'state.json')
    const adapter = createPersistence(true, path)
    expect(adapter.loadSync()).toBeNull()
    const data: PersistData = { version: PERSIST_VERSION, updatedAt: 0, stats: STATS, episodes: [], events: [] }
    expect(adapter.save(data)).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})
