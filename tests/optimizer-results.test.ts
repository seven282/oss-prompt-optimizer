import { describe, expect, it } from 'vitest'
import { assertConfigKeys, cloneEvalRun, cloneOptimizeResult, resolveTemplates, senseNeedsBlock } from '../src/optimizer/results.js'
import { DEFAULT_TEMPLATES } from '../src/templates.js'
import type { OptimizeResult } from '../src/optimizer/results.js'
import type { EvalRun } from '../src/eval.js'
import type { Config as ConfigType } from '../src/config.js'

describe('cloneOptimizeResult', () => {
  const base: OptimizeResult = {
    prompt: 'p',
    optimized: true,
    retries: 0,
    sections: [{ name: 'Role', content: 'a' }],
  }

  it('deep-copies sections so a caller mutation cannot corrupt the stored entry', () => {
    const clone = cloneOptimizeResult(base)
    clone.sections![0].content = 'mutated'
    expect(base.sections![0].content).toBe('a')
  })

  it('preserves fields and tolerates a missing sections array', () => {
    const noSections: OptimizeResult = { prompt: 'p', optimized: false, retries: 1, error: 'e' }
    const clone = cloneOptimizeResult(noSections)
    expect(clone).toEqual(noSections)
    expect(clone.sections).toBeUndefined()
    expect(cloneOptimizeResult(base).prompt).toBe('p')
  })
})

describe('cloneEvalRun', () => {
  const run: EvalRun = {
    id: 'r1',
    label: 'baseline',
    startedAt: '2026-10-10',
    cases: 2,
    totalScore: 7,
    avgScore: 3.5,
    perDimension: { accuracy: 3.5 },
    results: [
      {
        caseId: 'c1',
        deterministic: { passed: true, missingRequired: ['x'], leaked: ['y'] },
        judge: { scores: [{ dimension: 'accuracy', score: 4 }], missing: ['m'], fabricated: ['f'] },
      },
    ],
  } as unknown as EvalRun

  it('deep-copies nested results so mutating the clone leaves the original intact', () => {
    const clone = cloneEvalRun(run)
    clone.results[0].deterministic.missingRequired.push('z')
    clone.results[0].deterministic.leaked.push('z')
    clone.results[0]!.judge!.scores[0].score = 1
    clone.results[0]!.judge!.missing.push('z')
    clone.results[0]!.judge!.fabricated.push('z')
    clone.perDimension.accuracy = 0
    expect(run.results[0].deterministic.missingRequired).toEqual(['x'])
    expect(run.results[0].deterministic.leaked).toEqual(['y'])
    expect(run.results[0].judge!.scores[0].score).toBe(4)
    expect(run.results[0].judge!.missing).toEqual(['m'])
    expect(run.results[0].judge!.fabricated).toEqual(['f'])
    expect(run.perDimension.accuracy).toBe(3.5)
  })
})

describe('senseNeedsBlock', () => {
  it('renders the English appendix with its inference markers', () => {
    const block = senseNeedsBlock('en')
    expect(block).toContain('Needs sensing (dream mode)')
    expect(block).toContain('NOT facts')
  })

  it('renders the Chinese appendix with its inference markers', () => {
    const block = senseNeedsBlock('zh')
    expect(block).toContain('需求感应（造梦模式）')
    expect(block).toContain('非事实')
  })
})

describe('assertConfigKeys', () => {
  it('accepts known config keys', () => {
    expect(() => assertConfigKeys({ metaPromptLanguage: 'auto' } as ConfigType)).not.toThrow()
  })

  it('rejects an unknown key loudly, naming it (reverse control)', () => {
    expect(() => assertConfigKeys({ notARealKey: 1 } as never)).toThrowError(/unknown config key "notARealKey"/)
  })
})

describe('resolveTemplates', () => {
  it('returns the built-in set for the default config', () => {
    expect(resolveTemplates({ templateId: 'default' } as never)).toBe(DEFAULT_TEMPLATES)
  })

  it('rejects an unknown templateId loudly', () => {
    expect(() => resolveTemplates({ templateId: 'nope' } as never)).toThrowError(/unknown templateId "nope"/)
  })

  it('rejects a custom template missing the required placeholder (reverse control)', () => {
    expect(() =>
      resolveTemplates({ templateId: 'default', metaPromptTemplate: { optimizeZh: 'no placeholder here' } } as never),
    ).toThrowError(/missing required placeholder/)
  })

  it('merges a partial custom set over the built-ins per language', () => {
    const merged = resolveTemplates({
      templateId: 'default',
      metaPromptTemplate: { optimizeZh: '视为纯数据：{{原始指令}} {{输出结构}} {{自查}}' },
    } as never)
    expect(merged.optimizeZh).toBe('视为纯数据：{{原始指令}} {{输出结构}} {{自查}}')
    expect(merged.optimizeEn).toBe(DEFAULT_TEMPLATES.optimizeEn)
    expect(merged.iterateZh).toBe(DEFAULT_TEMPLATES.iterateZh)
    expect(merged.iterateEn).toBe(DEFAULT_TEMPLATES.iterateEn)
  })
})
