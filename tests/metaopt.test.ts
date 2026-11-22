import { describe, expect, it } from 'vitest'
import { adviseFromRuns, formatMetaAdvice, type MetaAdviceReport } from '../src/metaopt.js'
import { SEMANTIC_DEFAULT_THRESHOLD, semanticMatch, type SemanticScorer } from '../src/cache.js'
import type { EvalRun } from '../src/eval.js'

function run(over: Partial<EvalRun> = {}): EvalRun {
  return {
    ts: 1,
    cases: 4,
    optimized: 4,
    deterministicPass: 4,
    scored: 3,
    injectionCases: 0,
    leaked: 0,
    aggregate: 0.8,
    deterministicPassRate: 1,
    perDimension: { clarity: 4.5, impact: 2.4, specificity: 3.2 },
    billedInputTokens: 100,
    outputTokens: 50,
    mined: false,
    results: [],
    ...over,
  }
}

describe('P4 offline meta advice is structured and text-free', () => {
  it('ranks the weakest dimension first with its category', () => {
    const report = adviseFromRuns([run()])
    expect(report.runs).toBe(1)
    expect(report.scoredCases).toBe(3)
    expect(report.aggregate).toBe(0.8)
    expect(report.advice[0]).toMatchObject({ dimension: 'impact', mean: 2.4, category: 'strengthen' })
    expect(report.advice[1]).toMatchObject({ dimension: 'specificity', category: 'watch' })
    expect(report.advice[2]).toMatchObject({ dimension: 'clarity', category: 'maintain' })
  })

  it('averages a dimension across runs and ignores non-finite scores', () => {
    const report = adviseFromRuns([
      run({ perDimension: { clarity: 4, impact: 2 } }),
      run({ perDimension: { clarity: 3, impact: 4, broken: Number.NaN } }),
    ])
    const clarity = report.advice.find((a) => a.dimension === 'clarity')!
    expect(clarity.mean).toBe(3.5)
    expect(clarity.samples).toBe(2)
    expect(report.advice.find((a) => a.dimension === 'broken')).toBeUndefined()
  })

  it('never turns an absent score into a zero', () => {
    const report = adviseFromRuns([run({ aggregate: undefined, perDimension: {} })])
    expect(report.aggregate).toBeUndefined()
    expect(report.advice).toHaveLength(0)
    expect(formatMetaAdvice(report, 'en')).toContain('No dimension scores yet')
  })

  it('honours custom thresholds and the result limit', () => {
    // 2.4 sits between weak=2 and strong=3 → 'watch'.
    const report = adviseFromRuns([run()], { weakThreshold: 2, strongThreshold: 3, limit: 1 })
    expect(report.advice).toHaveLength(1)
    expect(report.advice[0].dimension).toBe('impact')
    expect(report.advice[0].category).toBe('watch')
  })

  it('renders numbers and categories only, in both languages', () => {
    const report: MetaAdviceReport = adviseFromRuns([run()])
    const zh = formatMetaAdvice(report, 'zh')
    const en = formatMetaAdvice(report, 'en')
    expect(zh).toContain('需加强')
    expect(zh).toContain('不生成提示词原文')
    expect(en).toContain('strengthen')
    expect(en).toContain('no prompt text')
    // No diff markers and no instruction text can appear.
    expect(zh).not.toMatch(/^\+/m)
    expect(en).not.toMatch(/^-/m)
  })

  it('clamps a negative limit to zero results', () => {
    const report = adviseFromRuns([run()], { limit: -5 })
    expect(report.advice).toHaveLength(0)
  })
})

describe('P5 semantic scorer is opt-in and context-isolated', () => {
  const scorer: SemanticScorer = (a, b) => (a === b ? 1 : a.includes(b) || b.includes(a) ? 0.9 : 0.2)

  it('returns false with no scorer even for identical text', () => {
    expect(semanticMatch('same', 'same', undefined)).toBe(false)
  })

  it('uses the high default threshold and honours a custom one', () => {
    expect(SEMANTIC_DEFAULT_THRESHOLD).toBe(0.95)
    expect(semanticMatch('report 2026', 'report', scorer)).toBe(false) // 0.9 < 0.95
    expect(semanticMatch('report 2026', 'report', scorer, { threshold: 0.85 })).toBe(true)
    expect(semanticMatch('x', 'x', scorer)).toBe(true)
  })

  it('refuses a hit across different context scopes', () => {
    expect(semanticMatch('a', 'a', scorer, { aScope: 'turn-1', bScope: 'turn-2' })).toBe(false)
    expect(semanticMatch('a', 'a', scorer, { aScope: 'turn-1', bScope: 'turn-1' })).toBe(true)
  })

  it('treats two absent scopes as the same global namespace', () => {
    expect(semanticMatch('a', 'a', scorer, {})).toBe(true)
  })

  it('rejects a non-finite score rather than trusting it', () => {
    const broken: SemanticScorer = () => Number.NaN
    expect(semanticMatch('a', 'a', broken)).toBe(false)
    const infinity: SemanticScorer = () => Number.POSITIVE_INFINITY
    expect(semanticMatch('a', 'a', infinity)).toBe(false)
  })
})
