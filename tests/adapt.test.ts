import { describe, expect, it } from 'vitest'
import {
  getSmartDefaults,
  resolveParams,
  computeAdaptation,
  formatAdaptationHints,
  DEFAULT_ADAPT_CONFIG,
} from '../src/adapt.js'
import type { AdaptationHints, UserOverrides } from '../src/adapt.js'
import { computePreferences } from '../src/preference.js'
import { EpisodeLog } from '../src/episode.js'
import type { Episode } from '../src/episode.js'
import type { TaskType } from '../src/meta.js'

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
    localMode: 'on',
    ...overrides,
  }
}

describe('getSmartDefaults', () => {
  const cases: [TaskType, { profile: string; localTemplate: string; temperature: number }][] = [
    ['code',     { profile: 'fast',    localTemplate: 'off', temperature: 0.15 }],
    ['writing',  { profile: 'balanced', localTemplate: 'off', temperature: 0.4  }],
    ['analysis', { profile: 'balanced', localTemplate: 'off', temperature: 0.2  }],
    ['ops',      { profile: 'fast',    localTemplate: 'off', temperature: 0.15 }],
    ['other',    { profile: 'balanced', localTemplate: 'off', temperature: 0.2  }],
  ]

  for (const [taskType, expected] of cases) {
    it(`returns correct defaults for ${taskType}`, () => {
      const defaults = getSmartDefaults(taskType)
      expect(defaults.profile).toBe(expected.profile)
      expect(defaults.localTemplate).toBe(expected.localTemplate)
      expect(defaults.temperature).toBe(expected.temperature)
    })
  }

  it('falls back to other for unknown task type', () => {
    const defaults = getSmartDefaults('unknown' as TaskType)
    expect(defaults.profile).toBe('balanced')
  })
})

describe('resolveParams', () => {
  const baseConfig = { profile: 'balanced' as const, localTemplate: 'off' as const, temperature: 0.2 }

  it('returns base config when no overrides and no session hints', () => {
    const result = resolveParams('writing', { reasons: [] }, {}, baseConfig)
    expect(result.profile).toBe('balanced')
    expect(result.localTemplate).toBe('off')
    expect(result.temperature).toBe(0.2)
    expect(result.source).toBe('config')
  })

  it('Layer 3 user overrides win over everything', () => {
    const userOverrides: UserOverrides = { profile: 'fast', temperature: 0.5 }
    const result = resolveParams('writing', { reasons: [] }, userOverrides, baseConfig)
    expect(result.profile).toBe('fast')
    expect(result.temperature).toBe(0.5)
    // source reflects the last override applied (temperature after profile)
    expect(result.source).toBe('user:temp')
  })

  it('Layer 1 session hints override Layer 2 smart defaults', () => {
    const sessionHints: AdaptationHints = { profile: 'fast', reasons: ['test'] }
    const result = resolveParams('writing', sessionHints, {}, baseConfig)
    expect(result.profile).toBe('fast')
    expect(result.source).toBe('session:profile')
  })

  it('Layer 1 localTemplate hint works', () => {
    const sessionHints: AdaptationHints = { localTemplate: 'off', reasons: ['test'] }
    const result = resolveParams('code', sessionHints, {}, baseConfig)
    expect(result.localTemplate).toBe('off')
    expect(result.source).toBe('session:local')
  })

  it('Layer 1 temperature hint works', () => {
    const sessionHints: AdaptationHints = { temperature: 0.8, reasons: ['test'] }
    const result = resolveParams('analysis', sessionHints, {}, baseConfig)
    expect(result.temperature).toBe(0.8)
    expect(result.source).toBe('session:temp')
  })

  it('Layer 3 partial override preserves other layers', () => {
    const userOverrides: UserOverrides = { temperature: 0.7 }
    const sessionHints: AdaptationHints = { profile: 'fast', reasons: ['test'] }
    const result = resolveParams('writing', sessionHints, userOverrides, baseConfig)
    expect(result.profile).toBe('fast')   // from Layer 1
    expect(result.temperature).toBe(0.7)  // from Layer 3
    expect(result.source).toBe('user:temp')
  })

  it('priority: Layer 3 > Layer 1 > config', () => {
    const userOverrides: UserOverrides = { profile: 'balanced' }
    const sessionHints: AdaptationHints = { profile: 'fast', reasons: ['test'] }
    const result = resolveParams('writing', sessionHints, userOverrides, baseConfig)
    expect(result.profile).toBe('balanced') // Layer 3 wins over Layer 1
  })

  it('smart defaults used when no session hints and no user overrides', () => {
    const result = resolveParams('code', { reasons: [] }, {}, baseConfig)
    // code defaults: fast + auto + 0.15, but no session hints → falls to config
    expect(result.profile).toBe('balanced') // from baseConfig
    expect(result.source).toBe('config')
  })
})

describe('computeAdaptation', () => {
  it('returns empty hints with insufficient data', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 5; i++) log.push(makeEpisode())
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'on', 0.2)
    expect(hints.profile).toBeUndefined()
    expect(hints.reasons[0]).toContain('Insufficient data')
  })

  it('suggests balanced when edit rate is high', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 15; i++) {
      log.push(makeEpisode({ accepted: i < 5 })) // 67% edit rate
    }
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'fast', 'on', 0.2)
    expect(hints.profile).toBe('balanced')
    expect(hints.reasons.some(r => r.includes('edit rate'))).toBe(true)
  })

  it('suggests fast when edit rate is low', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 15; i++) {
      log.push(makeEpisode({ accepted: true })) // 0% edit rate
    }
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'on', 0.2)
    expect(hints.profile).toBe('fast')
    expect(hints.reasons.some(r => r.includes('edit rate'))).toBe(true)
  })

  it('suggests off when local acceptance is low', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 15; i++) {
      log.push(makeEpisode({ local: true, accepted: false })) // 0% acceptance
    }
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'on', 0.2)
    expect(hints.localTemplate).toBe('off')
    expect(hints.reasons.some(r => r.includes('local acceptance'))).toBe(true)
  })

  it('suggests auto when local acceptance is high', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 15; i++) {
      log.push(makeEpisode({ local: true, accepted: true })) // 100% acceptance
    }
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'off', 0.2)
    expect(hints.localTemplate).toBe('on')
    expect(hints.reasons.some(r => r.includes('local acceptance'))).toBe(true)
  })

  it('does not suggest local change when usage rate is low', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 15; i++) {
      log.push(makeEpisode({ local: false })) // 0% usage
    }
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'on', 0.2)
    expect(hints.localTemplate).toBeUndefined()
  })

  it('suggests lower temperature when quality declines', () => {
    const log = new EpisodeLog()
    // First batch: high quality
    for (let i = 0; i < 8; i++) {
      log.push(makeEpisode({ quality: 0.9 }))
    }
    // Second batch: low quality
    for (let i = 0; i < 8; i++) {
      log.push(makeEpisode({ quality: 0.5 }))
    }
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'on', 0.5)
    expect(hints.temperature).toBeLessThan(0.5)
    expect(hints.reasons.some(r => r.includes('declining'))).toBe(true)
  })

  it('does not lower temperature when already low', () => {
    const log = new EpisodeLog()
    for (let i = 0; i < 8; i++) log.push(makeEpisode({ quality: 0.9 }))
    for (let i = 0; i < 8; i++) log.push(makeEpisode({ quality: 0.5 }))
    const prefs = computePreferences(log)
    const hints = computeAdaptation(prefs, 'balanced', 'on', 0.2)
    expect(hints.temperature).toBeUndefined()
  })
})

describe('formatAdaptationHints', () => {
  it('returns no-adjustment message for empty hints', () => {
    const hints: AdaptationHints = { reasons: [] }
    expect(formatAdaptationHints(hints, 'zh')).toContain('无需调整')
    expect(formatAdaptationHints(hints, 'en')).toContain('No adjustments')
  })

  it('formats Chinese output with profile/local/temp', () => {
    const hints: AdaptationHints = {
      profile: 'fast',
      localTemplate: 'off',
      temperature: 0.3,
      reasons: ['test reason'],
    }
    const text = formatAdaptationHints(hints, 'zh')
    expect(text).toContain('自适应建议')
    expect(text).toContain('fast')
    expect(text).toContain('off')
    expect(text).toContain('0.3')
    expect(text).toContain('test reason')
  })

  it('formats English output', () => {
    const hints: AdaptationHints = {
      profile: 'balanced',
      reasons: ['edit rate high'],
    }
    const text = formatAdaptationHints(hints, 'en')
    expect(text).toContain('Adaptation Suggestions')
    expect(text).toContain('balanced')
    expect(text).toContain('edit rate high')
  })
})
