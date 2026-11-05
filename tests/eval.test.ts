import { describe, expect, it } from 'vitest'
import {
  GOLDEN_SET,
  WEAK_REFERENCE,
  buildRun,
  calibratesAsExpected,
  checkDeterministic,
  cleanMinedSnippet,
  compareToBaseline,
  deterministicPasses,
  evalVerdictToken,
  formatEvalComparison,
  formatEvalRun,
  fromConfig,
  mineSessionInstructions,
  selectCases,
  withUsage,
  type CaseResult,
  type EvalCase,
} from '../src/eval.js'

const FOUR_SECTIONS = `## Role
资深项目助理，擅长周报撰写与要点提炼。

## Task
总结本周进展与下周计划，列出关键结果与风险。

## Context
面向团队与上级，聚焦进展与待办事项。

## Format
分节列出，每项一行，先成果后计划。`

/** A case result with sensible defaults, for aggregate tests. */
function result(overrides: Partial<CaseResult> & { id: string }): CaseResult {
  return {
    instructionChars: 10,
    deterministic: {
      structural: true, expectations: true, missingRequired: [], leaked: [], outputChars: 100, outputTokens: 60,
    },
    score: 1,
    ...overrides,
  }
}

describe('golden set integrity', () => {
  it('has unique ids', () => {
    const ids = GOLDEN_SET.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every task type the plugin claims to serve', () => {
    const ids = GOLDEN_SET.map((item) => item.id).join(' ')
    for (const needle of ['writing', 'code', 'analysis', 'ops']) expect(ids).toContain(needle)
  })

  it('carries at least one injection probe with a canary', () => {
    const probes = GOLDEN_SET.filter((item) => item.injection === true)
    expect(probes.length).toBeGreaterThanOrEqual(1)
    for (const probe of probes) expect(probe.mustNotInclude?.length ?? 0).toBeGreaterThan(0)
  })

  it('marks a core subset and keeps it smaller than the full set', () => {
    const core = GOLDEN_SET.filter((item) => item.core === true)
    expect(core.length).toBeGreaterThan(0)
    expect(core.length).toBeLessThan(GOLDEN_SET.length)
  })

  it('includes a vague instruction and an already-optimized one (grader traps)', () => {
    expect(GOLDEN_SET.some((item) => item.id === 'vague-request')).toBe(true)
    const optimized = GOLDEN_SET.find((item) => item.id === 'already-optimized')
    expect(optimized?.instruction).toContain('## Role')
  })
})

describe('deterministic grading', () => {
  it('accepts a well-formed four-section prompt', () => {
    const check = checkDeterministic({ mustInclude: ['周报'] }, `${FOUR_SECTIONS}\n周报`, 'sections', 10)
    expect(check.structural).toBe(true)
    expect(check.expectations).toBe(true)
    expect(deterministicPasses(check)).toBe(true)
    expect(check.outputTokens).toBeGreaterThan(0)
  })

  it('rejects a prompt that is missing required content', () => {
    const check = checkDeterministic({ mustInclude: ['销售额'] }, FOUR_SECTIONS, 'sections', 10)
    expect(check.missingRequired).toEqual(['销售额'])
    expect(check.expectations).toBe(false)
    expect(deterministicPasses(check)).toBe(false)
  })

  it('rejects a prompt that leaks an injected canary', () => {
    const check = checkDeterministic({ mustNotInclude: ['PWNED'] }, `${FOUR_SECTIONS}\nPWNED`, 'sections', 10)
    expect(check.leaked).toEqual(['PWNED'])
    expect(deterministicPasses(check)).toBe(false)
  })

  it('uses the same structural gate as the pipeline (plain style forbids headings)', () => {
    const withHeadings = checkDeterministic({}, FOUR_SECTIONS, 'plain', 10)
    expect(withHeadings.structural).toBe(false)
    const plain = checkDeterministic({}, '资深助理。总结本周进展与下周计划，面向团队与上级，分节列出，每项一行。', 'plain', 10)
    expect(plain.structural).toBe(true)
  })

  it('scores the shipped reference pairs in the right order (offline calibration)', () => {
    const withReferences = GOLDEN_SET.filter((item) => item.referenceGood !== undefined)
    expect(withReferences.length).toBeGreaterThanOrEqual(4)
    for (const item of withReferences) {
      expect(calibratesAsExpected(item, item.referenceGood!, 10), `${item.id} referenceGood must pass`).toBe(true)
      const bad = item.referenceBad ?? WEAK_REFERENCE
      expect(calibratesAsExpected(item, bad, 10), `${item.id} referenceBad must fail`).toBe(false)
    }
  })

  it('keeps the injection case’s good reference clean and its bad one leaking', () => {
    const probe = GOLDEN_SET.find((item) => item.id === 'injection-guard')!
    expect(calibratesAsExpected(probe, probe.referenceGood!, 10)).toBe(true)
    expect(checkDeterministic(probe, probe.referenceBad!, 'sections', 10).leaked).toEqual(['PWNED'])
  })
})

describe('selectCases', () => {
  it('returns the core subset by default and everything with all', () => {
    expect(selectCases(GOLDEN_SET).every((item) => item.core === true)).toBe(true)
    expect(selectCases(GOLDEN_SET, { all: true })).toHaveLength(GOLDEN_SET.length)
  })

  it('treats maxCases 0 as "no cap" (the plugin-wide convention)', () => {
    expect(selectCases(GOLDEN_SET, { all: true, maxCases: 0 })).toHaveLength(GOLDEN_SET.length)
  })

  it('caps the pool deterministically, so two runs measure the same slice', () => {
    const capped = selectCases(GOLDEN_SET, { all: true, maxCases: 3 })
    expect(capped.map((item) => item.id)).toEqual(GOLDEN_SET.slice(0, 3).map((item) => item.id))
  })
})

describe('fromConfig', () => {
  it('assigns stable ids to configured cases that omit one', () => {
    const cases = fromConfig([{ instruction: 'a' }, { instruction: 'b' }])
    expect(cases.map((item) => item.id)).toEqual(['user-1', 'user-2'])
  })

  it('keeps an explicit id and forwards the deterministic expectations', () => {
    const cases = fromConfig([{ id: 'mine', instruction: 'a', mustInclude: ['x'], injection: true }])
    expect(cases[0]).toMatchObject({ id: 'mine', mustInclude: ['x'], injection: true })
  })
})

describe('buildRun / withUsage', () => {
  const cases: EvalCase[] = [
    { id: 'a', instruction: 'x', core: true },
    { id: 'b', instruction: 'y', injection: true, mustNotInclude: ['PWNED'] },
  ]

  it('aggregates scores and the deterministic gate rate', () => {
    const run = buildRun([
      result({ id: 'a', score: 1 }),
      result({ id: 'b', score: 0.5 }),
    ], cases, {})
    expect(run.cases).toBe(2)
    expect(run.scored).toBe(2)
    expect(run.aggregate).toBeCloseTo(0.75, 5)
    expect(run.deterministicPassRate).toBe(1)
    expect(run.injectionCases).toBe(1)
    expect(run.leaked).toBe(0)
  })

  it('leaves the aggregate undefined when nothing scored, rather than reporting 0', () => {
    const run = buildRun([result({ id: 'a', score: undefined, error: 'judge-incomplete' })], cases, {})
    expect(run.aggregate).toBeUndefined()
    expect(run.scored).toBe(0)
  })

  it('counts leaked canaries and failed gates', () => {
    const run = buildRun([
      result({
        id: 'b',
        score: 0,
        deterministic: {
          structural: true, expectations: false, missingRequired: [], leaked: ['PWNED'], outputChars: 10, outputTokens: 5,
        },
      }),
    ], cases, {})
    expect(run.leaked).toBe(1)
    expect(run.deterministicPass).toBe(0)
  })

  it('averages each rubric dimension across judged cases', () => {
    const run = buildRun([
      result({
        id: 'a',
        judge: {
          scores: [{ id: 'specificity', reason: 'r', score: 5 }, { id: 'economy', reason: 'r', score: 1 }],
          missing: [], fabricated: [], rejected: [], rejectedCount: 0, mean: 4, normalized: 0.75, complete: true,
        },
      }),
      result({
        id: 'b',
        judge: {
          scores: [{ id: 'specificity', reason: 'r', score: 3 }],
          missing: [], fabricated: [], rejected: [], rejectedCount: 0, mean: 3, normalized: 0.5, complete: true,
        },
      }),
    ], cases, {})
    expect(run.perDimension.specificity).toBeCloseTo(4, 5)
    expect(run.perDimension.economy).toBeCloseTo(1, 5)
  })

  it('records the usage ledger totals', () => {
    const run = withUsage(buildRun([result({ id: 'a' })], cases, {}), { billedInputTokens: 1234, outputTokens: 567 })
    expect(run.billedInputTokens).toBe(1234)
    expect(run.outputTokens).toBe(567)
  })

  it('copies the results array so a later mutation cannot rewrite history', () => {
    const results = [result({ id: 'a' })]
    const run = buildRun(results, cases, {})
    results.push(result({ id: 'b' }))
    expect(run.results).toHaveLength(1)
  })
})

describe('compareToBaseline', () => {
  it('reports no-baseline on the first run and still applies the threshold', () => {
    expect(compareToBaseline(0.7, undefined, 0.02, 0.6).verdict).toBe('no-baseline')
    expect(compareToBaseline(0.5, undefined, 0.02, 0.6).verdict).toBe('below-threshold')
    // The threshold travels with the comparison so the formatter never has to
    // guess what "below" meant.
    expect(compareToBaseline(0.5, undefined, 0.02, 0.6).threshold).toBe(0.6)
  })

  it('flags a regression only beyond the tolerance', () => {
    expect(compareToBaseline(0.69, 0.7, 0.02, 0.6).verdict).toBe('pass')
    expect(compareToBaseline(0.67, 0.7, 0.02, 0.6).verdict).toBe('regress')
  })

  it('prefers regress over below-threshold when both apply (direction of travel)', () => {
    // 0.4 is below the 0.6 threshold AND worse than the 0.5 baseline.
    expect(compareToBaseline(0.4, 0.5, 0.02, 0.6).verdict).toBe('regress')
  })

  it('computes the delta and tolerates a missing score on either side', () => {
    expect(compareToBaseline(0.8, 0.6, 0.02, 0.6).delta).toBeCloseTo(0.2, 5)
    expect(compareToBaseline(undefined, 0.6, 0.02, 0.6).verdict).toBe('no-score')
    expect(compareToBaseline(undefined, 0.6, 0.02, 0.6).delta).toBeUndefined()
  })
})

describe('formatting', () => {
  const run = buildRun([result({ id: 'writing-report', score: 0.8 })], [GOLDEN_SET[0]!], { label: 'smoke' })

  it('renders the run summary in both languages', () => {
    expect(formatEvalRun(run, 'zh')).toContain('综合分 0.80')
    expect(formatEvalRun(run, 'zh')).toContain('结构门 1/1')
    expect(formatEvalRun(run, 'en')).toContain('Score 0.80')
    expect(formatEvalRun(run, 'zh')).toContain('smoke')
  })

  it('renders each comparison verdict in both languages', () => {
    expect(formatEvalComparison(compareToBaseline(0.7, undefined, 0.02, 0.6), 'zh')).toContain('无基线')
    expect(formatEvalComparison(compareToBaseline(0.5, undefined, 0.02, 0.6), 'zh')).toContain('尚无基线')
    expect(formatEvalComparison(compareToBaseline(0.5, 0.7, 0.02, 0.6), 'zh')).toContain('回归')
    expect(formatEvalComparison(compareToBaseline(0.75, 0.7, 0.02, 0.6), 'en')).toContain('Pass')
  })

  it('emits a machine-readable verdict token', () => {
    const token = evalVerdictToken(run, compareToBaseline(0.8, 0.7, 0.02, 0.6))
    expect(token).toMatch(/^EVAL\|SCORE:0\.800\|BASE:0\.700\|DELTA:0\.100\|VERDICT:PASS\|CASES:1\|GATE:1\|LEAK:0$/)
  })

  it('emits NA rather than a fake number when nothing scored', () => {
    const empty = buildRun([result({ id: 'a', score: undefined })], [GOLDEN_SET[0]!], {})
    expect(evalVerdictToken(empty, compareToBaseline(undefined, undefined, 0.02, 0.6))).toContain('SCORE:NA')
  })
})

describe('cleanMinedSnippet (privacy-safe dataset mining)', () => {
  it('keeps a plausible user instruction', () => {
    expect(cleanMinedSnippet('帮我写一份周报，总结本周的进展和下周计划'))
      .toBe('帮我写一份周报，总结本周的进展和下周计划')
  })

  it('drops structural lines from an already-optimized prompt', () => {
    const cleaned = cleanMinedSnippet('## Role\n资深助理。\n## Task\n写周报')
    expect(cleaned).toBe('资深助理。 写周报')
  })

  it('drops role/task labels and assistant pleasantries', () => {
    expect(cleanMinedSnippet('角色：资深助理\n任务：写周报')).toBeUndefined()
    expect(cleanMinedSnippet('好的，我来帮你写周报')).toBeUndefined()
  })

  it('drops code fences', () => {
    expect(cleanMinedSnippet('帮我看看这段\n```js\nconst a = 1\n```')).toBeUndefined()
  })

  it('drops snippets that are too short or too long', () => {
    expect(cleanMinedSnippet('短')).toBeUndefined()
    expect(cleanMinedSnippet('帮我写'.repeat(200))).toBeUndefined()
  })

  it('collapses whitespace so a quoted excerpt becomes one instruction', () => {
    expect(cleanMinedSnippet('帮我写周报\n\n  总结进展  ')).toBe('帮我写周报 总结进展')
  })
})

describe('mineSessionInstructions (best-effort by contract)', () => {
  const engineWith = (items: { bestMatch?: { snippet?: string } }[]) => ({
    searchSessions: async () => ({ items }),
  })

  it('returns nothing when the host has no session-query service', async () => {
    expect(await mineSessionInstructions(undefined)).toEqual([])
    expect(await mineSessionInstructions({})).toEqual([])
  })

  it('deduplicates across queries and respects the limit', async () => {
    const engine = engineWith([
      { bestMatch: { snippet: '帮我写一份周报，总结本周进展' } },
      { bestMatch: { snippet: '帮我写一份周报，总结本周进展' } },
      { bestMatch: { snippet: '帮我分析这份销售数据的趋势' } },
    ])
    const mined = await mineSessionInstructions(engine, { limit: 2, queries: ['a', 'b'] })
    expect(mined).toEqual(['帮我写一份周报，总结本周进展', '帮我分析这份销售数据的趋势'])
  })

  it('swallows a throwing engine instead of failing the run', async () => {
    const engine = { searchSessions: async () => { throw new Error('service boom') } }
    expect(await mineSessionInstructions(engine, { queries: ['a'] })).toEqual([])
  })

  it('tolerates a malformed page shape', async () => {
    const engine = { searchSessions: async () => ({}) as never }
    expect(await mineSessionInstructions(engine, { queries: ['a'] })).toEqual([])
  })

  it('returns nothing when the limit is zero', async () => {
    const engine = engineWith([{ bestMatch: { snippet: '帮我写一份周报，总结本周进展' } }])
    expect(await mineSessionInstructions(engine, { limit: 0 })).toEqual([])
  })

  it('stops early on an aborted signal', async () => {
    const engine = engineWith([{ bestMatch: { snippet: '帮我写一份周报，总结本周进展' } }])
    const controller = new AbortController()
    controller.abort()
    expect(await mineSessionInstructions(engine, { signal: controller.signal, queries: ['a'] })).toEqual([])
  })
})

describe('eval branch matrix', () => {
  it('marks below-threshold with and without a baseline', () => {
    const withBase = compareToBaseline(0.5, 0.5, 0.02, 0.6)
    expect(withBase.verdict).toBe('below-threshold')
    expect(formatEvalComparison(withBase, 'zh')).toContain('基线 0.50')
    const noBase = compareToBaseline(0.5, undefined, 0.02, 0.6)
    expect(noBase.verdict).toBe('below-threshold')
    expect(formatEvalComparison(noBase, 'zh')).toContain('尚无基线')
    expect(formatEvalComparison(noBase, 'en')).toContain('no baseline yet')
  })

  it('renders every comparison verdict in both languages', () => {
    const verdicts = ['no-baseline', 'no-score', 'regress', 'below-threshold', 'pass'] as const
    for (const verdict of verdicts) {
      const comparison = { baseline: 0.7, current: 0.8, delta: 0.1, threshold: 0.6, verdict }
      expect(formatEvalComparison(comparison, 'zh').length).toBeGreaterThan(0)
      expect(formatEvalComparison(comparison, 'en').length).toBeGreaterThan(0)
    }
    expect(formatEvalComparison({ baseline: 0.7, current: 0.8, delta: undefined, threshold: 0.6, verdict: 'pass' }, 'zh'))
      .toContain('n/a')
  })

  it('averages each judged dimension over the cases that scored it', () => {
    const judge = (mean: number, clarity: number) => ({
      complete: true, mean, normalized: mean / 5, missing: [], rejected: [], rejectedCount: 0, fabricated: [],
      scores: [{ id: 'clarity', reason: '结构完整', score: clarity }],
    })
    const run = buildRun(
      [result({ id: 'a', judge: judge(4, 4) }), result({ id: 'b', judge: judge(2, 2) })],
      [{ id: 'a', instruction: 'x' }, { id: 'b', instruction: 'y' }],
      { label: 'nightly', judgeModel: 'j/m', optimizerModel: 'o/m', mined: true, ts: 1 },
    )
    expect(run.perDimension.clarity).toBe(3)
    expect(run.label).toBe('nightly')
    expect(run.judgeModel).toBe('j/m')
    expect(run.optimizerModel).toBe('o/m')
    expect(run.mined).toBe(true)
    expect(run.ts).toBe(1)
  })

  it('reports a zero gate rate for an empty case set and counts optimized/leaked cases', () => {
    const empty = buildRun([], [], {})
    expect(empty.deterministicPassRate).toBe(0)
    expect(empty.aggregate).toBeUndefined()

    const leaked = result({
      id: 'probe',
      deterministic: {
        structural: true, expectations: false, missingRequired: ['x'], leaked: ['CANARY'],
        outputChars: 10, outputTokens: 5,
      },
      score: 0,
      error: 'deterministic-failed',
    })
    const failed = result({ id: 'broken', score: 0, error: 'optimize-failed' })
    const run = buildRun([leaked, failed], [
      { id: 'probe', instruction: 'p', injection: true },
      { id: 'broken', instruction: 'b' },
    ], {})
    expect(run.injectionCases).toBe(1)
    expect(run.leaked).toBe(1)
    expect(run.scored).toBe(2)
    // A case the optimizer never returned is not "optimized".
    expect(run.optimized).toBe(1)
  })

  it('assigns stable ids to configured cases that omit one', () => {
    const cases = fromConfig([
      { instruction: '一', dimensions: ['safety'], mustInclude: ['a'], mustNotInclude: ['b'], injection: true },
      { id: '  ', instruction: '二' },
      { id: 'named', instruction: '三' },
    ])
    expect(cases.map((item) => item.id)).toEqual(['user-1', 'user-2', 'named'])
    expect(cases[0]?.dimensions).toEqual(['safety'])
    expect(cases[0]?.mustInclude).toEqual(['a'])
    expect(cases[0]?.mustNotInclude).toEqual(['b'])
    expect(cases[0]?.injection).toBe(true)
    expect(cases[1]?.dimensions).toBeUndefined()
  })

  it('renders injection probes, mined samples, dimension means and every case line', () => {
    const run = {
      ts: 0, cases: 3, optimized: 2, deterministicPass: 1, scored: 2, injectionCases: 1, leaked: 1,
      aggregate: 0.5, deterministicPassRate: 1 / 3, perDimension: { clarity: 4.25 },
      billedInputTokens: 10, outputTokens: 20, mined: true,
      results: [
        result({ id: 'plain', judge: undefined, error: undefined }),
        result({ id: 'judged', judge: {
          complete: true, mean: 4.2, normalized: 0.84, missing: [], rejected: [], rejectedCount: 0, fabricated: [],
          scores: [{ id: 'clarity', reason: '结构完整，目标明确', score: 4.2 }],
        } }),
        result({ id: 'incomplete', judge: {
          complete: false, mean: undefined, normalized: undefined, missing: ['impact'], rejected: [], rejectedCount: 0, fabricated: [],
          scores: [],
        }, deterministic: {
          structural: false, expectations: true, missingRequired: ['要求'], leaked: ['CANARY'],
          outputChars: 4, outputTokens: 2,
        }, error: 'judge-incomplete' }),
      ],
    }
    const zh = formatEvalRun(run, 'zh')
    expect(zh).toContain('注入探针 1 例')
    expect(zh).toContain('含会话挖掘样本')
    expect(zh).toContain('维度均分（1-5）：clarity 4.3')
    expect(zh).toContain('未判分')
    expect(zh).toContain('（1-5 均分 4.2）')
    expect(zh).toContain('不完整（缺 impact）')
    expect(zh).toContain('泄漏 CANARY')
    expect(zh).toContain('缺 要求')

    const en = formatEvalRun(run, 'en')
    expect(en).toContain('Injection probes 1')
    expect(en).toContain('includes mined samples')
    expect(en).toContain('Dimension means (1-5): clarity 4.3')
  })
})

describe('unmeasured eval runs', () => {
  it('renders n/a when nothing was scored and names the failure', () => {
    const run = {
      ts: 0, cases: 1, optimized: 1, deterministicPass: 0, scored: 0, injectionCases: 0, leaked: 0,
      aggregate: undefined, deterministicPassRate: 0, perDimension: {},
      billedInputTokens: 0, outputTokens: 0, mined: false,
      results: [result({ id: 'broken', judge: undefined, error: 'optimize-error' })],
    }
    const zh = formatEvalRun(run, 'zh')
    expect(zh).toContain('综合分 n/a')
    // A failed case says why instead of pretending it was never judged.
    expect(zh).toContain('optimize-error')
    expect(formatEvalRun(run, 'en')).toContain('Score n/a')
  })

  it('skips a mined hit without a snippet instead of reading undefined', async () => {
    const engine = { searchSessions: async () => ({ items: [{}, { bestMatch: { snippet: '帮我写一份周报，面向团队' } }] }) }
    const mined = await mineSessionInstructions(engine, { limit: 1, queries: ['q1'] })
    expect(mined).toEqual(['帮我写一份周报，面向团队'])
  })
})
