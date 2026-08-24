import { describe, expect, it } from 'vitest'
import { EpisodeLog, truncateEpisodeInput, EPISODE_INPUT_MAX_CHARS } from '../src/episode.js'
import type { Episode } from '../src/episode.js'

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    ts: Date.now(),
    input: 'test instruction',
    taskType: 'writing',
    local: false,
    refined: false,
    outputTokens: 100,
    inputTokens: 50,
    durationMs: 500,
    callCount: 1,
    profile: 'balanced',
    localMode: 'auto',
    ...overrides,
  }
}

describe('truncateEpisodeInput', () => {
  it('returns short input unchanged', () => {
    const input = 'a'.repeat(EPISODE_INPUT_MAX_CHARS)
    expect(truncateEpisodeInput(input)).toBe(input)
  })

  it('truncates long input with ellipsis', () => {
    const input = 'a'.repeat(EPISODE_INPUT_MAX_CHARS + 50)
    const result = truncateEpisodeInput(input)
    expect(result.length).toBe(EPISODE_INPUT_MAX_CHARS + 1)
    expect(result.endsWith('…')).toBe(true)
  })

  it('returns empty string for empty input', () => {
    expect(truncateEpisodeInput('')).toBe('')
  })
})

describe('EpisodeLog', () => {
  it('starts empty', () => {
    const log = new EpisodeLog()
    expect(log.size).toBe(0)
    expect(log.all()).toHaveLength(0)
  })

  it('push adds episodes', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode({ input: 'first' }))
    log.push(makeEpisode({ input: 'second' }))
    expect(log.size).toBe(2)
  })

  it('all returns all episodes', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode({ input: 'a' }))
    log.push(makeEpisode({ input: 'b' }))
    const all = log.all()
    expect(all).toHaveLength(2)
    expect(all[0].input).toBe('a')
    expect(all[1].input).toBe('b')
  })

  it('recent returns N most recent', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode({ input: 'a' }))
    log.push(makeEpisode({ input: 'b' }))
    log.push(makeEpisode({ input: 'c' }))
    expect(log.recent(2)).toHaveLength(2)
    expect(log.recent(2)[0].input).toBe('b')
    expect(log.recent(2)[1].input).toBe('c')
  })

  it('recent clamps to available count', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode())
    expect(log.recent(100)).toHaveLength(1)
  })

  it('evicts oldest when at capacity', () => {
    const log = new EpisodeLog(3)
    log.push(makeEpisode({ input: 'a' }))
    log.push(makeEpisode({ input: 'b' }))
    log.push(makeEpisode({ input: 'c' }))
    log.push(makeEpisode({ input: 'd' }))
    expect(log.size).toBe(3)
    expect(log.all()[0].input).toBe('b')
    expect(log.all()[2].input).toBe('d')
  })

  it('clear removes all episodes', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode())
    log.push(makeEpisode())
    log.clear()
    expect(log.size).toBe(0)
  })

  it('filter returns matching episodes', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode({ taskType: 'writing' }))
    log.push(makeEpisode({ taskType: 'code' }))
    log.push(makeEpisode({ taskType: 'writing' }))
    const writing = log.filter(ep => ep.taskType === 'writing')
    expect(writing).toHaveLength(2)
  })

  it('updateFeedback updates quality and accepted', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode())
    log.updateFeedback(0, { quality: 0.8, accepted: true })
    const ep = log.all()[0]
    expect(ep.quality).toBe(0.8)
    expect(ep.accepted).toBe(true)
  })

  it('updateFeedback ignores invalid index', () => {
    const log = new EpisodeLog()
    log.push(makeEpisode())
    log.updateFeedback(99, { quality: 0.5 })
    expect(log.all()[0].quality).toBeUndefined()
  })

  it('respects custom maxEntries', () => {
    const log = new EpisodeLog(1)
    log.push(makeEpisode({ input: 'a' }))
    log.push(makeEpisode({ input: 'b' }))
    expect(log.size).toBe(1)
    expect(log.all()[0].input).toBe('b')
  })

  it('min maxEntries is 1', () => {
    const log = new EpisodeLog(0)
    log.push(makeEpisode({ input: 'a' }))
    log.push(makeEpisode({ input: 'b' }))
    expect(log.size).toBe(1)
  })
})
