import { describe, expect, it } from 'vitest'
import {
  ARMS,
  DEFAULT_DECIDE_OPTIONS,
  LEARNING_MAX_BUCKETS,
  armKey,
  betaSample,
  bucketObservations,
  boundLearningState,
  bucketOf,
  createLearningState,
  decayLearningState,
  decide,
  hash32,
  lengthBucketOf,
  loadLearningState,
  observe,
  parseArm,
  parseLearningState,
  posteriorMean,
  rewardOf,
  warmupFromScores,
} from '../src/learning.js'
import { toLearningSignal } from '../src/events.js'

describe('bucket and reward are metadata only', () => {
  it('buckets length into short / mid / long', () => {
    expect(lengthBucketOf(0)).toBe('short')
    expect(lengthBucketOf(16)).toBe('short')
    expect(lengthBucketOf(17)).toBe('mid')
    expect(lengthBucketOf(200)).toBe('mid')
    expect(lengthBucketOf(201)).toBe('long')
  })

  it('builds a stable bucket key from labels, never from the raw instruction', () => {
    expect(bucketOf('writing', 'writing-report', 40)).toBe('writing|writing-report|mid')
    expect(bucketOf('code', undefined, 8)).toBe('code|none|short')
    // Two different wordings with the same labels collapse to the same bucket.
    expect(bucketOf('writing', 'writing-report', 40)).toBe(bucketOf('writing', 'writing-report', 45))
  })

  it('keeps a missing quality signal absent rather than scoring it zero', () => {
    expect(rewardOf(undefined, 100, 2000)).toBeUndefined()
    expect(rewardOf(1, 0, 0)).toBe(1)
    // Cost terms: 0.3*(tokens/1000) + 0.2*(ms/10000).
    expect(rewardOf(1, 1000, 10000)).toBeCloseTo(0.5, 4)
    expect(rewardOf(0.2, 5000, 50000)).toBe(0)
    // Negative or NaN-ish inputs are clamped, not allowed to corrupt the state.
    expect(rewardOf(1, -5, -5)).toBe(1)
  })
})

describe('arm registry', () => {
  it('has exactly the six arms the runtime config can express', () => {
    expect(ARMS).toHaveLength(6)
    expect(new Set(ARMS.map(armKey)).size).toBe(6)
    for (const arm of ARMS) {
      expect(parseArm(armKey(arm))).toEqual(arm)
    }
    expect(parseArm('quality:on')).toBeUndefined()
    expect(parseArm('nope')).toBeUndefined()
  })
})

describe('Beta state', () => {
  it('starts with a Beta(1,1) prior and folds fractional rewards', () => {
    const state = createLearningState()
    expect(state.version).toBe(1)
    expect(bucketObservations(state, 'absent')).toBe(0)
    expect(posteriorMean({ alpha: 1, beta: 1, n: 0, ts: 0 })).toBe(0.5)

    observe(state, 'b', ARMS[0], 1, 1000)
    expect(bucketObservations(state, 'b')).toBe(1)
    expect(state.buckets.b?.[armKey(ARMS[0])]).toEqual({ alpha: 2, beta: 1, n: 1, ts: 1000 })
    observe(state, 'b', ARMS[0], 0, 2000)
    expect(state.buckets.b?.[armKey(ARMS[0])]).toEqual({ alpha: 2, beta: 2, n: 2, ts: 2000 })
    expect(state.updatedAt).toBe(2000)
  })

  it('accumulates independent arms in the same bucket', () => {
    const state = createLearningState()
    observe(state, 'b', ARMS[0], 1)
    observe(state, 'b', ARMS[1], 0)
    expect(bucketObservations(state, 'b')).toBe(2)
    expect(posteriorMean(state.buckets.b?.[armKey(ARMS[0])]!)).toBeGreaterThan(0.5)
    expect(posteriorMean(state.buckets.b?.[armKey(ARMS[1])]!)).toBeLessThan(0.5)
  })

  it('evicts the least-recently-observed bucket at the bound', () => {
    const state = createLearningState()
    for (let i = 0; i < LEARNING_MAX_BUCKETS + 4; i++) {
      observe(state, `bucket-${i}`, ARMS[0], 0.5, i)
    }
    expect(Object.keys(state.buckets)).toHaveLength(LEARNING_MAX_BUCKETS)
    expect(state.buckets['bucket-0']).toBeUndefined()
    expect(state.buckets[`bucket-${LEARNING_MAX_BUCKETS + 3}`]).toBeDefined()
  })

  it('honours a smaller custom bound', () => {
    const state = createLearningState()
    for (let i = 0; i < 5; i++) observe(state, `b${i}`, ARMS[0], 0.5, i)
    boundLearningState(state, 2)
    expect(Object.keys(state.buckets)).toHaveLength(2)
  })

  it('pulls posteriors toward the prior on decay', () => {
    const state = createLearningState()
    for (let i = 0; i < 10; i++) observe(state, 'b', ARMS[0], 1)
    const before = { ...state.buckets.b![armKey(ARMS[0])] }
    decayLearningState(state, 0.5, 9999)
    const after = state.buckets.b![armKey(ARMS[0])]
    expect(after.alpha).toBeGreaterThan(1)
    expect(after.alpha).toBeLessThan(before.alpha)
    expect(after.n).toBeCloseTo(before.n * 0.5)
    expect(state.updatedAt).toBe(9999)
    // A full decay resets everything to the prior.
    decayLearningState(state, 1)
    expect(state.buckets.b![armKey(ARMS[0])].alpha).toBe(1)
    expect(state.buckets.b![armKey(ARMS[0])].beta).toBe(1)
  })

  it('applies half-life decay on load when the state is old', () => {
    const state = createLearningState()
    const then = 1000
    observe(state, 'b', ARMS[0], 1, then)
    const alphaBefore = state.buckets.b![armKey(ARMS[0])].alpha
    const raw = JSON.parse(JSON.stringify(state))
    // One half-life after the last update halves the posterior's distance
    // from the prior.
    const restored = loadLearningState(raw, then + 30 * 24 * 60 * 60 * 1000)
    expect(restored.buckets.b![armKey(ARMS[0])].alpha).toBeLessThan(alphaBefore)
    expect(restored.buckets.b![armKey(ARMS[0])].alpha).toBeGreaterThan(1)
  })

  it('leaves a fresh state alone on load', () => {
    const state = createLearningState()
    expect(loadLearningState(state, state.updatedAt)).toEqual(state)
  })
})

describe('state parsing is best-effort and privacy-safe', () => {
  it('rejects a wrong version, a primitive, and a missing bucket map', () => {
    expect(parseLearningState(null)).toEqual(createLearningState())
    expect(parseLearningState('nope')).toEqual(createLearningState())
    expect(parseLearningState({ version: 2, buckets: {} })).toEqual(createLearningState())
    expect(parseLearningState({ version: 1 })).toEqual(createLearningState())
    expect(parseLearningState({ version: 1, buckets: 'nope' })).toEqual(createLearningState())
  })

  it('drops unknown arms, malformed stats and non-finite values', () => {
    const raw = {
      version: 1,
      updatedAt: 7,
      buckets: {
        good: {
          'fast:off': { alpha: 3, beta: 2, n: 2, ts: 5 },
          'unknown:arm': { alpha: 9, beta: 9, n: 9, ts: 5 },
          'fast:on': { alpha: 'x', beta: 2, n: 1, ts: 5 },
          'fast:hybrid': { alpha: 1, beta: 2, n: -1, ts: 5 },
        },
        bad: 'not an object',
      },
    }
    const parsed = parseLearningState(raw)
    expect(parsed.updatedAt).toBe(7)
    expect(Object.keys(parsed.buckets)).toEqual(['good'])
    expect(Object.keys(parsed.buckets.good!)).toEqual(['fast:off'])
    // Priors are restored even when a stat carries a sub-prior alpha.
    const low = parseLearningState({ version: 1, buckets: { b: { 'fast:off': { alpha: 0, beta: 0, n: 1, ts: 0 } } } })
    expect(low.buckets.b!['fast:off'].alpha).toBe(1)
    expect(low.buckets.b!['fast:off'].beta).toBe(1)
  })

  it('fills a missing ts and updatedAt', () => {
    const parsed = parseLearningState({ version: 1, buckets: { b: { 'fast:off': { alpha: 2, beta: 1, n: 1 } } } })
    expect(parsed.buckets.b!['fast:off'].ts).toBe(0)
    expect(parsed.updatedAt).toBe(0)
  })
})

describe('Thompson decisions are deterministic and logged', () => {
  it('hashes deterministically and distinguishes similar strings', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
    expect(hash32('abc')).not.toBe(hash32('abd'))
    expect(hash32('')).toBe(0x811c9dc5)
  })

  it('samples a Beta posterior with a reproducible random stream', () => {
    const stat = { alpha: 5, beta: 2, n: 6, ts: 0 }
    const a = betaSample(stat, (() => { let s = 1; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) })())
    const b = betaSample(stat, (() => { let s = 1; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) })())
    expect(a).toBe(b)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(1)
  })

  it('uses deterministic hashing during warmup', () => {
    const state = createLearningState()
    const first = decide(state, 'writing|x|mid', { ...DEFAULT_DECIDE_OPTIONS, seed: 'run-1' })
    const second = decide(state, 'writing|x|mid', { ...DEFAULT_DECIDE_OPTIONS, seed: 'run-1' })
    expect(first).toEqual(second)
    expect(first.warmup).toBe(true)
    expect(first.propensity).toBe(1)
    expect(parseArm(first.armKey)).toBeDefined()
    // A different seed may pick a different arm in cold start.
    const other = decide(state, 'writing|x|mid', { ...DEFAULT_DECIDE_OPTIONS, seed: 'run-2' })
    expect(other.armKey).toBeDefined()
  })

  it('switches to posterior sampling once the bucket is warm', () => {
    const state = createLearningState()
    for (let i = 0; i < 60; i++) observe(state, 'warm', ARMS[3], 1, i)
    const decision = decide(state, 'warm', { ...DEFAULT_DECIDE_OPTIONS, seed: 's', warmupObservations: 50 })
    expect(decision.warmup).toBe(false)
    expect(decision.propensity).toBeGreaterThan(0)
    expect(decision.propensity).toBeLessThanOrEqual(1)
    expect(parseArm(decision.armKey)).toBeDefined()
    // Reproducible for the same seed and state.
    expect(decide(state, 'warm', { ...DEFAULT_DECIDE_OPTIONS, seed: 's', warmupObservations: 50 })).toEqual(decision)
  })

  it('never exceeds the configured exploration floor in aggregate', () => {
    const state = createLearningState()
    for (let i = 0; i < 60; i++) observe(state, 'b', ARMS[i % ARMS.length], 0.5, i)
    let explored = 0
    const REPLAYS = 200
    for (let i = 0; i < REPLAYS; i++) {
      if (decide(state, 'b', { ...DEFAULT_DECIDE_OPTIONS, seed: `seed-${i}`, exploreFloor: 0.1 }).exploration) explored++
    }
    // The floor is a probability cap, not an exact quota; with 200 draws the
    // observed share should sit comfortably below an obvious violation.
    expect(explored / REPLAYS).toBeLessThan(0.25)
  })

  it('handles the extreme exploration floors', () => {
    const state = createLearningState()
    for (let i = 0; i < 60; i++) observe(state, 'b', ARMS[0], 1, i)
    const never = decide(state, 'b', { ...DEFAULT_DECIDE_OPTIONS, seed: 'a', exploreFloor: 0 })
    const always = decide(state, 'b', { ...DEFAULT_DECIDE_OPTIONS, seed: 'a', exploreFloor: 1 })
    expect(never.exploration).toBe(false)
    expect(always.exploration).toBe(true)
    expect(always.propensity).toBeGreaterThan(0)
  })
})

describe('golden-set warmup and event signal', () => {
  it('seeds a posterior from precomputed scores without a model call', () => {
    const state = createLearningState()
    warmupFromScores(state, 'b', ARMS[0], [1, 0.8, 0.6])
    const stat = state.buckets.b![armKey(ARMS[0])]
    expect(stat.n).toBe(3)
    expect(stat.alpha).toBeCloseTo(1 + 2.4)
    expect(stat.beta).toBeCloseTo(1 + 0.6)
    expect(bucketObservations(state, 'b')).toBe(3)
    // Repeated warmup adds rather than replaces.
    warmupFromScores(state, 'b', ARMS[0], [0])
    expect(bucketObservations(state, 'b')).toBe(4)
  })

  it('clamps warmup scores into [0,1]', () => {
    const state = createLearningState()
    warmupFromScores(state, 'b', ARMS[0], [-1, 5])
    // [0,1] → alpha += 1, beta += 1 on top of the Beta(1,1) prior.
    expect(state.buckets.b![armKey(ARMS[0])].alpha).toBe(2)
    expect(state.buckets.b![armKey(ARMS[0])].beta).toBe(2)
  })

  it('maps a decision to an event-safe signal with no instruction text', () => {
    const state = createLearningState()
    const decision = decide(state, 'writing|x|mid', { ...DEFAULT_DECIDE_OPTIONS, seed: 'run' })
    const signal = toLearningSignal(decision, 'shadow', 'writing|x|mid')
    expect(signal).toEqual({
      bucket: 'writing|x|mid',
      arm: decision.armKey,
      propensity: decision.propensity,
      exploration: decision.exploration,
      warmup: decision.warmup,
      mode: 'shadow',
    })
    expect(JSON.stringify(signal)).not.toContain('instruction')
  })
})

describe('P3 reuse: temperature bias and scene route', () => {
  it('derives a tiny additive temperature bias from the arm profile', async () => {
    const { armTemperatureBias, clampTemperature } = await import('../src/learning.js')
    const { ARMS } = await import('../src/learning.js')
    const fast = ARMS.find((a) => a.profile === 'fast')!
    const balanced = ARMS.find((a) => a.profile === 'balanced')!
    expect(armTemperatureBias(fast)).toBe(-0.05)
    expect(armTemperatureBias(balanced)).toBe(0.05)
    // Far below the 0.35 candidate spread, so diversity is preserved.
    expect(Math.abs(armTemperatureBias(fast))).toBeLessThan(0.35)
    expect(clampTemperature(-0.1)).toBe(0)
    expect(clampTemperature(2.5)).toBe(2)
    expect(clampTemperature(0.12345)).toBe(0.123)
  })
})
