import { describe, expect, it } from 'vitest'
import { computePreferences, formatPreferences } from '../src/preference.js'
import { EpisodeLog } from '../src/episode.js'
import type { Episode } from '../src/episode.js'

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    ts: Date.now(),
    input: 'test',
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

function fillLog(log: EpisodeLog, count: number, overrides: Partial<Episode> = {}): void {
  for (let i = 0; i < count; i++) {
    log.push(makeEpisode({ ...overrides, ts: Date.now() + i }))
  }
}

describe('computePreferences', () => {
  it('returns empty model for empty log', () => {
    const log = new EpisodeLog()
    const prefs = computePreferences(log)
    expect(prefs.total).toBe(0)
    expect(prefs.dominantTaskType).toBeUndefined()
    expect(prefs.dominantSubtype).toBeUndefined()
  })

  it('computes task type frequency', () => {
    const log = new EpisodeLog()
    fillLog(log, 5, { taskType: 'writing' })
    fillLog(log, 3, { taskType: 'code' })
    const prefs = computePreferences(log)
    expect(prefs.total).toBe(8)
    expect(prefs.taskTypeFreq.get('writing')).toBe(5)
    expect(prefs.taskTypeFreq.get('code')).toBe(3)
    expect(prefs.dominantTaskType).toBe('writing')
  })

  it('computes subtype frequency', () => {
    const log = new EpisodeLog()
    fillLog(log, 4, { taskType: 'writing', subtype: 'writing-report' })
    fillLog(log, 2, { taskType: 'writing', subtype: 'writing-email' })
    const prefs = computePreferences(log)
    expect(prefs.subtypeFreq.get('writing-report')).toBe(4)
    expect(prefs.subtypeFreq.get('writing-email')).toBe(2)
    expect(prefs.dominantSubtype).toBe('writing-report')
  })

  it('computes profile frequency', () => {
    const log = new EpisodeLog()
    fillLog(log, 6, { profile: 'fast' })
    fillLog(log, 4, { profile: 'balanced' })
    const prefs = computePreferences(log)
    expect(prefs.profileFreq.get('fast')).toBe(6)
    expect(prefs.profileFreq.get('balanced')).toBe(4)
  })

  it('computes local usage and acceptance rates', () => {
    const log = new EpisodeLog()
    fillLog(log, 3, { local: true, accepted: true })
    fillLog(log, 2, { local: true, accepted: false })
    fillLog(log, 5, { local: false })
    const prefs = computePreferences(log)
    expect(prefs.localUsageRate).toBeCloseTo(0.5)
    expect(prefs.localAcceptanceRate).toBeCloseTo(0.6)
  })

  it('computes edit rate', () => {
    const log = new EpisodeLog()
    fillLog(log, 3, { accepted: false })
    fillLog(log, 7, { accepted: true })
    const prefs = computePreferences(log)
    expect(prefs.editRate).toBeCloseTo(0.3)
  })

  it('computes average quality', () => {
    const log = new EpisodeLog()
    fillLog(log, 2, { quality: 0.8 })
    fillLog(log, 2, { quality: 0.6 })
    const prefs = computePreferences(log)
    expect(prefs.avgQuality).toBeCloseTo(0.7)
    expect(prefs.feedbackCount).toBe(4)
  })

  it('computes average tokens and duration', () => {
    const log = new EpisodeLog()
    fillLog(log, 3, { outputTokens: 200, inputTokens: 100, durationMs: 1000 })
    const prefs = computePreferences(log)
    expect(prefs.avgOutputTokens).toBe(200)
    expect(prefs.avgInputTokens).toBe(100)
    expect(prefs.avgDurationMs).toBe(1000)
  })

  it('respects window size', () => {
    const log = new EpisodeLog()
    fillLog(log, 5, { taskType: 'code' })
    fillLog(log, 3, { taskType: 'writing' })
    const prefs = computePreferences(log, 3)
    expect(prefs.total).toBe(3)
    expect(prefs.dominantTaskType).toBe('writing')
  })
})

describe('formatPreferences', () => {
  it('returns empty message for zero episodes', () => {
    const log = new EpisodeLog()
    const prefs = computePreferences(log)
    expect(formatPreferences(prefs, 'zh')).toContain('暂无优化记录')
    expect(formatPreferences(prefs, 'en')).toContain('No optimization records')
  })

  it('formats Chinese output with stats', () => {
    const log = new EpisodeLog()
    fillLog(log, 5, { taskType: 'writing', profile: 'balanced' })
    const prefs = computePreferences(log)
    const text = formatPreferences(prefs, 'zh')
    expect(text).toContain('优化统计')
    expect(text).toContain('writing')
    expect(text).toContain('balanced')
  })

  it('formats English output with stats', () => {
    const log = new EpisodeLog()
    fillLog(log, 5, { taskType: 'code', profile: 'fast' })
    const prefs = computePreferences(log)
    const text = formatPreferences(prefs, 'en')
    expect(text).toContain('Optimization Stats')
    expect(text).toContain('code')
    expect(text).toContain('fast')
  })

  it('includes local template stats', () => {
    const log = new EpisodeLog()
    fillLog(log, 3, { local: true, accepted: true })
    fillLog(log, 2, { local: false })
    const prefs = computePreferences(log)
    const text = formatPreferences(prefs, 'zh')
    expect(text).toContain('本地模板')
    expect(text).toContain('使用率')
    expect(text).toContain('接受率')
  })

  it('includes quality stats when feedback exists', () => {
    const log = new EpisodeLog()
    fillLog(log, 3, { quality: 0.8, accepted: true })
    const prefs = computePreferences(log)
    const text = formatPreferences(prefs, 'zh')
    expect(text).toContain('质量评分')
    expect(text).toContain('编辑率')
  })

  it('omits quality section when no feedback', () => {
    const log = new EpisodeLog()
    fillLog(log, 3, {})
    const prefs = computePreferences(log)
    const text = formatPreferences(prefs, 'zh')
    expect(text).not.toContain('质量评分')
  })
})
