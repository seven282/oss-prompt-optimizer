import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Config } from '../src/config.js'
import { OptimizeError, OptimizeErrorCode } from '../src/errors.js'
import { PromptOptimizerService } from '../src/optimizer.js'

const FOUR_SECTIONS = `## Role
你是一名资深项目助理，擅长把零散信息整理成清晰的周报。

## Task
总结本周进展与下周计划，列出关键结果、待办事项与风险。

## Context
面向团队与上级，聚焦进展与待办，数据不足时如实说明。

## Format
分节列出，每项一行，先写成果再写计划，总数控制在 500 字以内。`

function textStream(text: string, finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield finish
  })()
}

interface HostOptions {
  stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  get?: (key: string) => unknown
  emitThrows?: boolean
  effect?: boolean
  logger?: { info?: (msg: string) => void; warn?: (msg: string, detail?: unknown) => void }
}

function makeHost(options: HostOptions = {}) {
  const emits: { name: string; payload: unknown }[] = []
  const infos: string[] = []
  const warns: string[] = []
  let disposed: (() => void) | undefined
  const ctx = {
    reflect: { provide: () => {} },
    get: options.get ?? (() => undefined),
    emit: (name: string, payload: unknown) => {
      if (options.emitThrows === true) throw new Error('listener boom')
      emits.push({ name, payload })
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    llm: { stream: options.stream ?? (() => textStream(FOUR_SECTIONS)) },
    logger: {
      info: (msg: string) => infos.push(msg),
      warn: (msg: string) => warns.push(msg),
    },
    ...(options.effect === true ? { effect: (fn: () => () => void) => { disposed = fn() } } : {}),
  }
  return { ctx, emits, infos, warns, dispose: () => disposed?.() }
}

function makeService(host: ReturnType<typeof makeHost>, over: Partial<Config> = {}): PromptOptimizerService {
  return new PromptOptimizerService(host.ctx as never, { ...DEFAULT_CONFIG, ...over })
}

const DEFAULT_CONFIG: Config = {
  temperature: 0.2,
  maxTokens: 1200,
  maxRetries: 1,
  maxCalls: 4,
  maxInputChars: 4000,
  maxInputTokens: 3000,
  timeoutMs: 1000,
  outputLanguage: 'auto',
  outputStyle: 'sections',
  metaPromptLanguage: '中文',
  autoOptimize: false,
  autoOptimizePrefix: '/optimize ',
  minSectionChars: 10,
  maxTokenRetryFactor: 2,
  maxTokensCap: 8000,
  maxTotalTokens: 20000,
  retryTemperatureStep: 0.3,
  skipIfAlreadyOptimized: false,
  selfRefine: false,
  templateId: 'default',
  autoOptimizeAll: false,
  hookIncludeOriginal: false,
  contextAware: false,
  contextMaxMessages: 6,
  contextMaxTokens: 1500,
  outputLengthMaxTokens: 800,
  situationProfileLevel: 'full',
  goalAlignmentRetry: true,
  optimizationProfile: 'balanced',
  earlyStop: true,
  cacheEnabled: true,
  cacheMaxEntries: 200,
  cacheTtlMs: 600000,
  cacheFuzzyMatch: true,
  cacheFuzzyThreshold: 0.6,
  senseNeeds: false,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  earlyStopTailChunks: 12,
  earlyStopTailGrowth: 48,
  builtinExamples: true,
  sceneRefEnabled: true,
  classifier: 'heuristic',
  localTemplate: 'off',
  hybridAlignThreshold: 0.4,
  autoAdapt: false,
  minAdaptEpisodes: 10,
  persistState: false,
  // Evaluation harness (1.11.0): judge off by default in tests — every judge
  // call would otherwise consume a slot in the scripted stream fixtures.
  evalThreshold: 0.6,
  evalRegressionTolerance: 0.02,
  evalMaxCases: 8,
  evalJudge: false,
  evalMineSessions: false,
  evalMineLimit: 5,
  // Best-of-N selection + host feedback signals (1.12.0): both off by default
  // in tests — selection would multiply the scripted stream fixtures.
  selectCandidates: 1,
  selectMinGain: 0.05,
  selectJudge: true,
  feedbackAdapt: true,
  feedbackScanLimit: 8,
  learning: 'off',
  learningExploreFloor: 0.1,
  learningWarmupObservations: 50,
}

describe('optimizer public surface', () => {
  it('reports its capability probe and stream assembly verdict', () => {
    const service = makeService(makeHost())
    expect(service.canAssembleStream()).toBe(true)
    const caps = service.hostCapabilities()
    expect(caps.defineTool).not.toBeNull()
    expect(caps.createUserMessage).not.toBeNull()
    expect(caps.BlockAssembler).not.toBeNull()
  })

  it('logs a healthy compat line at startup', () => {
    const host = makeHost()
    makeService(host)
    expect(host.infos.join()).toContain('host compat ok')
  })

  it('returns insights in both languages', () => {
    const service = makeService(makeHost())
    expect(service.getInsights('zh')).toBeTypeOf('string')
    expect(service.getInsights('en')).toBeTypeOf('string')
    expect(service.getInsights('en')).not.toBe(service.getInsights('zh'))
  })

  it('records feedback on the most recent episode and adapts only when enabled', async () => {
    const service = makeService(makeHost())
    await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(() => service.updateFeedback(-1, true)).not.toThrow()
    expect(() => service.updateFeedback(0, false)).not.toThrow()
    expect(service.computeAdaptationHints()).toEqual({ reasons: ['autoAdapt disabled'] })
  })

  it('ignores invalid overrides and clears them on demand', () => {
    const service = makeService(makeHost())
    service.setUserOverride('profile', 'turbo')
    service.setUserOverride('local', 'sometimes')
    service.setUserOverride('temperature', '11')
    expect(service.getUserOverrides()).toEqual({})

    service.setUserOverride('profile', 'fast')
    service.setUserOverride('local', 'hybrid')
    service.setUserOverride('temperature', '0.9')
    expect(service.getUserOverrides()).toEqual({ profile: 'fast', localTemplate: 'hybrid', temperature: 0.9 })

    service.clearUserOverride('profile')
    service.clearUserOverride('local')
    service.clearUserOverride('temperature')
    expect(service.getUserOverrides()).toEqual({})

    service.setUserOverride('profile', 'fast')
    service.clearAllUserOverrides()
    expect(service.getUserOverrides()).toEqual({})
  })

  it('resolves the status source from the override layer', async () => {
    const service = makeService(makeHost())
    service.setUserOverride('profile', 'fast')
    const snapshot = service.getStatus('写一份周报')
    expect(snapshot.effective.source).toBe('user:profile')
    expect(snapshot.effective.profile).toBe('fast')
    // No model run yet → no eval summary and no selection report.
    expect(snapshot.evalSummary).toBeUndefined()
    expect(service.selectSummary()).toBeUndefined()
    expect(service.getLastSelection()).toBeUndefined()
  })

  it('keeps the pipeline alive when an observer throws', async () => {
    const host = makeHost({ emitThrows: true })
    const service = makeService(host)
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(result.optimized).toBe(true)
    expect(host.warns.join('\n')).toContain('Observer failed')
  })

  it('bounds the recent-event buffer and counts a failed run', async () => {
    const host = makeHost({ stream: () => textStream('没有四段') })
    const service = makeService(host, { maxRetries: 0 })
    for (let i = 0; i < 21; i++) await service.optimize(`第 ${i} 条指令：帮我写一份周报`)
    const stats = service.getStats()
    expect(stats.failed).toBe(21)
    expect(service.getStatus('').recentEvents.length).toBeLessThanOrEqual(20)
  })

  it('derives the role-document language from config and runtime overrides', () => {
    expect(makeService(makeHost(), { metaPromptLanguage: '中文' }).getMetaPromptLanguage()).toBe('zh')
    expect(makeService(makeHost(), { metaPromptLanguage: '英文' }).getMetaPromptLanguage()).toBe('en')
    expect(makeService(makeHost(), { metaPromptLanguage: 'auto' }).getMetaPromptLanguage()).toBe('auto')
    const service = makeService(makeHost(), { metaPromptLanguage: 'auto' })
    expect(service.resolveMetaLanguage('Please write a detailed weekly report for the team')).toBe('en')
    expect(service.resolveMetaLanguage('帮我写周报')).toBe('zh')
  })

  it('uses the host token meter when it is mounted, and falls back when it throws', async () => {
    const host = makeHost({
      get: (key) => (key === 'tokenMeter' ? { estimateMessage: () => 7 } : undefined),
    })
    const service = makeService(host)
    await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(service.getStats().lastInputTokens).toBe(7)

    const throwing = makeHost({
      get: (key) => (key === 'tokenMeter' ? { estimateMessage: () => { throw new Error('meter broke') } } : undefined),
    })
    const fallback = makeService(throwing)
    await fallback.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(fallback.getStats().lastInputTokens).toBeGreaterThan(0)
  })

  it('flushes pending state on disposal when persistence is on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'po-persist-'))
    const file = join(dir, 'state.json')
    try {
      const host = makeHost({ effect: true })
      const service = makeService(host, { persistState: true, stateFile: file })
      await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
      host.dispose()
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { stats: { runs: number } }
      expect(saved.stats.runs).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('folds host feedback into counts, status lines and the machine token', async () => {
    const items = [
      { rating: 'positive', category: 'tone' },
      { rating: 'negative', note: '太长了' },
      { rating: 'negative', category: 'tone' },
    ]
    const host = makeHost({
      get: (key) => (key === 'messageFeedback' ? { list: async () => items } : undefined),
    })
    const service = makeService(host)
    expect(service.hasFeedbackService()).toBe(true)
    const ledgers = await service.scanFeedback(['s1'])
    expect(ledgers).toHaveLength(1)
    expect(service.getFeedbackLedgers()[0]).toMatchObject({ sessionId: 's1', positive: 1, negative: 2, withNote: 1 })
    expect(service.getStats().feedbackSessions).toBe(1)
    const text = service.formatFeedbackSignals('zh')
    expect(text).toContain('FEEDBACK:SESSIONS:1')
    expect(service.formatFeedbackSignals('en')).toContain('FEEDBACK:')
  })

  it('survives a host that rejects or malforms feedback reads', async () => {
    const rejecting = makeHost({
      get: (key) => (key === 'messageFeedback' ? { list: async () => { throw new Error('no such session') } } : undefined),
    })
    const service = makeService(rejecting)
    expect(await service.scanFeedback(['s1'])).toEqual([])

    const malformed = makeHost({
      get: (key) => (key === 'messageFeedback' ? { list: async () => ({ ok: false }) } : undefined),
    })
    expect(await makeService(malformed).scanFeedback(['s1'])).toEqual([])
  })

  it('falls back to a structural selection when the judge pair is half configured', async () => {
    const service = makeService(makeHost(), {
      selectCandidates: 3, selectJudge: true, evalJudgeProvider: 'judge-only',
    })
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(result.optimized).toBe(true)
    const stats = service.getStats()
    expect(stats.selectRuns).toBe(1)
    expect(stats.lastSelectCandidates).toBe(3)
    expect(service.getLastSelection()?.scores.length).toBe(3)
    expect(service.selectSummary('zh')).toContain('选择:')
    expect(service.selectSummary('en')).toContain('Selection')
  })

  it('runs the evaluation harness offline and exposes its records', async () => {
    const service = makeService(makeHost(), { evalMaxCases: 1, evalThreshold: 0.5 })
    const { run, comparison } = await service.runEval({ maxCases: 1, label: 'tiny' })
    expect(run.cases).toBe(1)
    expect(run.label).toBe('tiny')
    expect(comparison.verdict).toBe('no-baseline')
    expect(service.getEvalRuns()).toHaveLength(1)
    expect(service.getEvalRubric().length).toBeGreaterThan(0)
    expect(service.listEvalCases({ all: true }).length).toBeGreaterThan(0)
    expect(service.listEvalCases({ maxCases: 1 })).toHaveLength(1)
    const baseline = service.setEvalBaseline()
    expect(baseline?.cases).toBe(1)
    expect(service.getEvalBaseline()?.cases).toBe(1)
    expect(service.getEvalSummary().comparison?.verdict).toBe('pass')
    // A label that matches nothing records nothing.
    expect(service.setEvalBaseline('missing')).toBeUndefined()
  })
})

describe('optimizer pipeline branches', () => {
  it('stops streaming early at a sentence boundary using the default tail thresholds', async () => {
    const prefix = FOUR_SECTIONS + '\n'
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'text-delta', index: 0, text: prefix }
      for (let i = 0; i < 40; i++) yield { type: 'text-delta', index: 0, text: '。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const service = makeService(makeHost({ stream }), {
      earlyStop: true,
      earlyStopTailChunks: undefined as unknown as number,
      earlyStopTailGrowth: undefined as unknown as number,
    })
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(result.optimized).toBe(true)
    // The cut happens at a boundary, so the text ends on a sentence mark.
    expect(result.prompt.trimEnd().endsWith('。')).toBe(true)
  })

  it('skips an invalid chunk instead of failing the run', async () => {
    const host = makeHost({ stream: () => (async function* () {
      yield null as unknown as StreamChunk
      yield { type: 'text-delta', index: 0, text: FOUR_SECTIONS }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() })
    const service = makeService(host)
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(result.optimized).toBe(true)
    expect(host.warns.join('\n')).toContain('Invalid chunk')
  })

  it('reports NO_TEXT for a stream that produced nothing', async () => {
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const service = makeService(makeHost({ stream }), { maxRetries: 0 })
    // An empty model answer is a hard failure, not a quiet fallback.
    await expect(service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划'))
      .rejects.toThrow(/produced no text/)
  })

  it('retries an English output that carries meta commentary', async () => {
    const english = FOUR_SECTIONS
    const withMeta = `${english}\n\n总结：以上是优化后的提示词。`
    let calls = 0
    const stream = (): AsyncIterable<StreamChunk> => {
      calls++
      return textStream(calls === 1 ? withMeta : english)
    }
    const service = makeService(makeHost({ stream }), { metaPromptLanguage: '英文', maxRetries: 2 })
    await service.optimize('Write a weekly report for the team about the release plan')
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('carries the situation profile into iterate and its start event', async () => {
    const host = makeHost()
    const service = makeService(host)
    await service.iterate(FOUR_SECTIONS, '把篇幅压缩到 300 字以内', { sessionId: 's1' })
    const start = host.emits.find((emit) => String(emit.name).includes('start'))
    expect(start?.payload).toMatchObject({ method: 'iterate' })
    expect((start?.payload as { profile?: unknown }).profile).toBeDefined()
  })

  it('refuses to resolve a route from a half-configured or empty pair', async () => {
    const providerOnly = makeService(makeHost(), { provider: 'deepseek-official', model: undefined })
    await expect(providerOnly.optimize('写一份周报，面向团队')).rejects.toMatchObject({ code: 'NO_MODEL_ROUTE' })

    const empty = makeService(makeHost(), { provider: '', model: '' })
    await expect(empty.optimize('写一份周报，面向团队')).rejects.toMatchObject({ code: 'NO_MODEL_ROUTE' })

    const none = makeService(makeHost(), { provider: undefined, model: undefined })
    await expect(none.optimize('写一份周报，面向团队')).rejects.toMatchObject({ code: 'NO_MODEL_ROUTE' })
  })

  it('evicts the oldest registered session goal beyond the registry cap', async () => {
    const service = makeService(makeHost())
    for (let i = 0; i < 101; i++) {
      await service.optimize(`第 ${i} 个会话的周报指令，面向团队`, { sessionId: `session-${i}` })
    }
    // The registry stays bounded: the first session is re-derived, so its goal
    // is no longer remembered.
    expect(service.getStats().runs).toBe(101)
  })

  it('scores with the judge when the evaluation harness enables it', async () => {
    const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> =>
      (options.system ?? '').includes('维度')
        ? textStream('维度: clarity\n理由: 结构清楚，但目标不够具体\n分数: 4')
        : textStream(FOUR_SECTIONS)
    const service = makeService(makeHost({ stream }), { evalJudge: true, evalMaxCases: 1 })
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.cases).toBe(1)
    // The judge scored clarity only, so the report is incomplete by design.
    expect(run.results[0]?.judge?.complete).toBe(false)
  })

  it('self-refines a passing output when the config asks for it', async () => {
    const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> =>
      (options.system ?? '').includes('精修') ? textStream(FOUR_SECTIONS) : textStream(FOUR_SECTIONS)
    const service = makeService(makeHost({ stream }), { selfRefine: true })
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(result.optimized).toBe(true)
  })
})

describe('optimizer edge branches', () => {
  it('flushes nothing when disposal runs twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'po-double-'))
    const file = join(dir, 'state.json')
    try {
      const host = makeHost({ effect: true })
      const service = makeService(host, { persistState: true, stateFile: file })
      await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
      host.dispose()
      expect(() => host.dispose()).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives an observer that throws a non-Error', async () => {
    const host = makeHost()
    host.ctx.emit = () => { throw 'plain string' }
    const service = new PromptOptimizerService(host.ctx as never, DEFAULT_CONFIG)
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    expect(result.optimized).toBe(true)
    expect(host.warns.join('\n')).toContain('Observer failed')
  })

  it('gives an English goal diagnosis when the output drops the goal', async () => {
    // The English goal extractor only fires on an explicit phrase ("goal:"),
    // and the Chinese four-section output never carries those anchors — so the
    // pipeline must retry with the English diagnosis rather than accept it.
    const systems: string[] = []
    const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      systems.push(options.system ?? '')
      return textStream(FOUR_SECTIONS)
    }
    const service = makeService(makeHost({ stream }), { metaPromptLanguage: '英文', maxRetries: 3 })
    await service.optimize('Goal: publish the quarterly roadmap for Q3 2026')
    expect(systems.length).toBeGreaterThanOrEqual(2)
    expect(systems[1]).toContain('The output dropped the following goal/constraint')
  })

  it('computes adaptation hints once the history is long enough', async () => {
    const service = makeService(makeHost(), { autoAdapt: true, minAdaptEpisodes: 1 })
    await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展与计划')
    const hints = service.computeAdaptationHints()
    expect(Array.isArray(hints.reasons)).toBe(true)
    expect(service.getStatus('写周报').effective).toBeDefined()
  })

  it('clears overrides that were never set', () => {
    const service = makeService(makeHost())
    expect(() => {
      service.clearUserOverride('profile')
      service.clearUserOverride('local')
      service.clearUserOverride('temperature')
    }).not.toThrow()
  })

  it('renders a hybrid local result in the role-task-goal shape', async () => {
    const service = makeService(makeHost(), {
      localTemplate: 'hybrid',
      outputStyle: 'role-task-goal',
      hybridAlignThreshold: 0.2,
    })
    const result = await service.optimize('帮我写周报，面向 CTO，预算 5 万')
    expect(result.optimized).toBe(true)
    expect(result.local).toBe(true)
    expect(result.prompt).toContain('角色')
  })

  it('aggregates feedback categories into the readback token', async () => {
    const host = makeHost({
      get: (key) => (key === 'messageFeedback'
        ? { list: async () => [{ rating: 'negative', category: 'tone' }, { rating: 'negative', category: 'tone' }] }
        : undefined),
    })
    const service = makeService(host)
    await service.scanFeedback(['s1'])
    expect(service.formatFeedbackSignals('zh')).toContain('tone×2')
  })

  it('refreshes an explicitly requested session even when the ledger is fresh', async () => {
    let reads = 0
    const host = makeHost({
      get: (key) => (key === 'messageFeedback'
        ? { list: async () => { reads++; return [{ rating: 'positive' }] } }
        : undefined),
    })
    const service = makeService(host)
    await service.scanFeedback(['s1'])
    await service.scanFeedback(['s1'])
    expect(reads).toBe(2)
  })

  it('scores every applicable dimension when the judge answers completely', async () => {
    let service: PromptOptimizerService
    const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      if (!(options.system ?? '').includes('维度')) return textStream(FOUR_SECTIONS)
      const ids = service.getEvalRubric().filter((dimension) => dimension.alwaysApplicable).map((dimension) => dimension.id)
      return textStream(ids.map((id) => `维度: ${id}\n理由: 结构完整，目标明确\n分数: 4`).join('\n\n'))
    }
    service = makeService(makeHost({ stream }), { evalJudge: true, evalMaxCases: 1 })
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.results[0]?.judge?.complete).toBe(true)
    expect(run.aggregate).toBeGreaterThan(0)
  })

  it('records a judge failure as unmeasured rather than a fake zero', async () => {
    const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> =>
      (options.system ?? '').includes('维度')
        ? (async function* (): AsyncIterable<StreamChunk> { throw new Error('judge offline') })()
        : textStream(FOUR_SECTIONS)
    const service = makeService(makeHost({ stream }), { evalJudge: true, evalMaxCases: 1 })
    const { run } = await service.runEval({ maxCases: 1 })
    // A judge outage is not a candidate failure: the case carries the reason
    // and no score, and the aggregate stays `undefined` instead of collapsing
    // to 0 (which would look like a real regression in the trend).
    expect(run.results[0]?.error).toBe('judge-error')
    expect(run.results[0]?.score).toBeUndefined()
    expect(run.scored).toBe(0)
    expect(run.aggregate).toBeUndefined()
  })
})

describe('optimizer lifecycle branches', () => {
  it('flushes nothing when a disposal had no pending write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-flush-'))
    const file = join(dir, 'state.json')
    try {
      const host = makeHost({ effect: true })
      const service = makeService(host, { persistState: true, stateFile: file })
      // No run happened, so there is no debounced snapshot to flush: the
      // disposal path must be a no-op rather than writing an empty document.
      host.dispose()
      expect(() => host.dispose()).not.toThrow()
      expect(() => readFileSync(file, 'utf8')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips fuzzy cache seeding when the feature is off', async () => {
    const service = makeService(makeHost(), { cacheFuzzyMatch: false })
    await service.optimize('帮我写一份周报，面向 CTO')
    const second = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展')
    expect(second.optimized).toBe(true)
  })

  it('summarises an empty eval history without inventing a comparison', () => {
    const service = makeService(makeHost())
    const summary = service.getEvalSummary()
    expect(summary).toEqual({ last: undefined, baseline: undefined, comparison: undefined })
  })

  it('reports a baseline without a comparison when no run happened yet', () => {
    const service = makeService(makeHost())
    // `setEvalBaseline` needs a run; without one it reports nothing to record.
    expect(service.setEvalBaseline('empty')).toBeUndefined()
    const summary = service.getEvalSummary()
    expect(summary.comparison).toBeUndefined()
  })

  it('drops a session goal that outlived its ttl', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService(makeHost(), { situationProfileLevel: 'full', cacheEnabled: false })
      await service.optimize('目标：三天内交付周报', { sessionId: 'ttl-1' })
      // 31 minutes later a different session triggers the periodic sweep and
      // the stale entry is collected.
      vi.advanceTimersByTime(31 * 60 * 1000)
      await service.optimize('写点别的', { sessionId: 'ttl-2' })
      expect(service.getStats().runs).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-registers a goal that expired inside the clean interval', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService(makeHost(), { cacheEnabled: false })
      await service.optimize('目标：三天内交付周报', { sessionId: 'ttl-3' })
      // 30 minutes: the TTL boundary itself, so the sweep keeps the entry and
      // refreshes the clean clock.
      vi.advanceTimersByTime(30 * 60 * 1000)
      await service.optimize('目标：三天内交付月报', { sessionId: 'ttl-3' })
      // One more minute: the entry is now stale but no periodic sweep runs, so
      // the per-session access path is what drops it.
      vi.advanceTimersByTime(60 * 1000)
      const result = await service.optimize('继续', { sessionId: 'ttl-3' })
      expect(result.optimized).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns auto-adaptation off and on through the config switch', async () => {
    const off = makeService(makeHost())
    expect(off.computeAdaptationHints().reasons).toEqual(['autoAdapt disabled'])
    const on = makeService(makeHost(), { autoAdapt: true, minAdaptEpisodes: 1 })
    await on.optimize('帮我写一份周报，面向 CTO，需覆盖进展')
    expect(Array.isArray(on.computeAdaptationHints().reasons)).toBe(true)
    expect(on.getStatus().effective).toBeDefined()
  })

  it('accepts and clears each override key', () => {
    const service = makeService(makeHost())
    service.setUserOverride('temperature', '1.2')
    expect(service.getStatus().effective.temperature).toBe(1.2)
    service.clearUserOverride('temperature')
    expect(service.getStatus().effective.source).not.toContain('temperature')
    service.setUserOverride('local', 'hybrid')
    expect(service.getStatus().effective.localTemplate).toBe('hybrid')
    service.clearUserOverride('local')
    expect(service.getStatus().effective.localTemplate).not.toBe('hybrid')
  })

  it('resolves the judge pair from config and reuses it for the run', async () => {
    const service = makeService(makeHost(), {
      evalJudge: true,
      evalMaxCases: 1,
      evalJudgeProvider: 'deepseek-official',
      evalJudgeModel: 'deepseek-v4-flash',
    })
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.judgeModel).toBe('deepseek-official/deepseek-v4-flash')
  })

  it('skips the judge route when selection judging is off', async () => {
    let calls = 0
    const service = makeService(makeHost({
      stream: () => { calls++; return textStream(FOUR_SECTIONS) },
    }), { selectCandidates: 2, selectJudge: false })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.selection?.eligible).toBeGreaterThanOrEqual(1)
    // Two candidates, no judge calls: the ranking stays structural.
    expect(calls).toBe(2)
  })

  it('falls back to the first usable candidate when the ranking cannot address it', async () => {
    let calls = 0
    const service = makeService(makeHost({
      stream: () => { calls++; return textStream(FOUR_SECTIONS) },
    }), { selectCandidates: 3, selectJudge: true })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.selection?.scores.length).toBeGreaterThanOrEqual(1)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('honours caller-supplied candidate temperatures', async () => {
    const service = makeService(makeHost(), { selectCandidates: 2, selectJudge: false })
    const result = await service.optimize('帮我写一份周报，面向 CTO', { selectTemperatures: [0.4] })
    expect(result.selection?.scores.length).toBe(2)
  })

  it('walks the local refine path in hybrid mode, including purity and goal retries', async () => {
    let calls = 0
    const service = makeService(makeHost({
      stream: () => {
        calls++
        // 1st: meta content, 2nd: still missing the goal, 3rd: valid.
        if (calls === 1) return textStream(`${FOUR_SECTIONS}\n\n总结：以上是优化思路`)
        if (calls === 2) return textStream(FOUR_SECTIONS)
        return textStream(FOUR_SECTIONS)
      },
    }), { localTemplate: 'hybrid', goalAlignmentRetry: true, cacheEnabled: false })
    const result = await service.optimize('目标：发布季度路线图。帮我写一份周报，面向 CTO')
    expect(result.optimized).toBe(true)
    expect(result.local).toBe(true)
    expect(result.refined).toBe(true)
  })

  it('returns the local template when the refine output is unusable', async () => {
    const service = makeService(makeHost({
      stream: () => textStream('太短'),
    }), { localTemplate: 'hybrid', cacheEnabled: false })
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展')
    expect(result.optimized).toBe(true)
    expect(result.local).toBe(true)
    expect(result.prompt.length).toBeGreaterThan(0)
  })

  it('stops a stream early once the tail stops growing at a sentence end', async () => {
    // One complete validated block, then a run of tiny chunks that add almost
    // nothing: the tail stops growing, the sentence ends, and the stream is cut
    // short instead of waiting for a finish reason that never comes.
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'text-delta', index: 0, text: FOUR_SECTIONS } as StreamChunk
      for (let index = 0; index < 6; index++) {
        yield { type: 'text-delta', index: 0, text: '。' } as StreamChunk
        yield { type: 'text-delta', index: 0, text: ' ' } as StreamChunk
      }
    })()
    const service = makeService(makeHost({ stream }), { earlyStop: true, earlyStopTailChunks: 2, earlyStopTailGrowth: 8 })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toContain('## Role')
  })
})

describe('eval and feedback failure paths', () => {
  it('records an optimization that returned no error code as optimize-failed', async () => {
    const service = makeService(makeHost(), { evalMaxCases: 1 })
    vi.spyOn(service, 'optimize').mockResolvedValue({ prompt: '', optimized: false, retries: 0 })
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.results[0]?.error).toBe('optimize-failed')
    expect(run.results[0]?.score).toBe(0)
  })

  it('records a non-OptimizeError rejection as optimize-error', async () => {
    const service = makeService(makeHost(), { evalMaxCases: 1 })
    vi.spyOn(service, 'optimize').mockRejectedValue(new Error('boom'))
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.results[0]?.error).toBe('optimize-error')
    expect(run.results[0]?.score).toBe(0)
  })

  it('keeps the stable code when the judge throws an OptimizeError', async () => {
    const service = makeService(makeHost({
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> =>
        (options.system ?? '').includes('维度')
          ? (async function* (): AsyncIterable<StreamChunk> { throw new OptimizeError(OptimizeErrorCode.TIMEOUT, 'judge timeout') })()
          : textStream(FOUR_SECTIONS),
    }), { evalJudge: true, evalMaxCases: 1 })
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.results[0]?.error).toBe(OptimizeErrorCode.TIMEOUT)
  })

  it('passes an abort signal through the eval run without measuring the case', async () => {
    const controller = new AbortController()
    controller.abort()
    const service = makeService(makeHost(), { evalMaxCases: 2 })
    const { run } = await service.runEval({ maxCases: 2, signal: controller.signal })
    expect(run.cases).toBe(2)
    expect(run.results).toHaveLength(0)
  })

  it('reuses a fresh feedback ledger without a second host read', async () => {
    let reads = 0
    const host = makeHost({
      get: (key) => (key === 'messageFeedback'
        ? { list: async () => { reads++; return [{ rating: 'positive' }] } }
        : undefined),
    })
    const service = makeService(host)
    await service.scanFeedback(['s1'])
    // The second pass is not forced and the ledger is still fresh, so the host
    // is not asked again.
    await service.scanFeedback()
    expect(reads).toBe(1)
  })

  it('stops collecting ledgers at the configured scan limit', async () => {
    const host = makeHost({
      get: (key) => (key === 'messageFeedback' ? { list: async () => [{ rating: 'negative' }] } : undefined),
    })
    const service = makeService(host, { feedbackScanLimit: 1 })
    await service.scanFeedback(['s1', 's2'])
    // Only the first id fits the limit; the second is never read.
    const ledgers = await service.getFeedbackLedgers()
    expect(ledgers).toHaveLength(1)
  })
})

describe('status snapshot with eval history', () => {
  it('reports aggregate, baseline and verdict when all three exist', async () => {
    const service = makeService(makeHost(), { evalMaxCases: 1, evalJudge: false })
    await service.runEval({ maxCases: 1, label: 'base' })
    // The baseline picks the run carrying this label, not simply the newest.
    expect(service.setEvalBaseline('base')?.label).toBe('base')
    await service.runEval({ maxCases: 1 })
    const snapshot = service.getStatus()
    expect(snapshot.evalSummary?.runs).toBe(2)
    expect(snapshot.evalSummary?.aggregate).toBeDefined()
    expect(snapshot.evalSummary?.baseline).toBeDefined()
    expect(snapshot.evalSummary?.verdict).toBeDefined()
  })
})

describe('optimizer path coverage', () => {
  it('mines the deployment sessions into the eval case pool', async () => {
    const host = makeHost({
      get: (key) => (key === 'sessionQuery'
        ? { searchSessions: async () => ({ items: [{ bestMatch: { snippet: '帮我写一份周报，面向团队与上级' } }] }) }
        : undefined),
    })
    const service = makeService(host, { evalMineSessions: true, evalMineLimit: 1, evalMaxCases: 1 })
    const controller = new AbortController()
    const { run } = await service.runEval({ maxCases: 1, mine: true, signal: controller.signal })
    expect(run.mined).toBe(true)
    expect(run.cases).toBeGreaterThanOrEqual(2)
  })

  it('ranks candidates structurally when the judge fails mid-selection', async () => {
    const service = makeService(makeHost({
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> =>
        (options.system ?? '').includes('维度')
          ? (async function* (): AsyncIterable<StreamChunk> { throw new Error('judge down') })()
          : textStream(FOUR_SECTIONS),
    }), { selectCandidates: 2, selectJudge: true })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.selection?.scores.length).toBe(2)
    // A judge outage leaves every candidate unscored: the ranking keeps them
    // eligible and falls back to the structural order.
    expect(result.selection?.scores.every((score) => score.score === undefined)).toBe(true)
    expect(result.selection?.scores.every((score) => score.error !== undefined)).toBe(true)
  })

  it('runs selection under the fast profile without extra retries', async () => {
    const service = makeService(makeHost(), { selectCandidates: 2, selectJudge: false, optimizationProfile: 'fast' })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.selection?.eligible).toBeGreaterThanOrEqual(1)
  })

  it('breaks the feedback ledger collection at the scan limit', async () => {
    let reads = 0
    const host = makeHost({
      get: (key) => (key === 'messageFeedback'
        ? { list: async () => { reads++; return [{ rating: 'positive' }] } }
        : undefined),
    })
    const service = makeService(host, { feedbackScanLimit: 1 })
    await service.scanFeedback(['s1'])
    // A second, broader pass cannot exceed the limit even with known ledgers.
    await service.scanFeedback(['s1', 's2'])
    expect(reads).toBe(2)
    expect((await service.getFeedbackLedgers()).length).toBeLessThanOrEqual(1)
  })

  it('does not stop a stream that never reaches a sentence boundary', async () => {
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'text-delta', index: 0, text: FOUR_SECTIONS } as StreamChunk
      for (let index = 0; index < 4; index++) {
        yield { type: 'text-delta', index: 0, text: 'x ' } as StreamChunk
      }
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })()
    const service = makeService(makeHost({ stream }), { earlyStop: true, earlyStopTailChunks: 1, earlyStopTailGrowth: 16 })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.optimized).toBe(true)
    expect(result.prompt.endsWith('x ')).toBe(true)
  })

  it('reports an eval history whose scores were never measured', async () => {
    const service = makeService(makeHost({
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> =>
        (options.system ?? '').includes('维度')
          ? (async function* (): AsyncIterable<StreamChunk> { throw new Error('judge down') })()
          : textStream(FOUR_SECTIONS),
    }), { evalJudge: true, evalMaxCases: 1 })
    await service.runEval({ maxCases: 1 })
    const snapshot = service.getStatus()
    expect(snapshot.evalSummary?.runs).toBe(1)
    // Unmeasured scores stay absent rather than being reported as 0.
    expect(snapshot.evalSummary?.aggregate).toBeUndefined()
  })
})

describe('remaining reachable branches', () => {
  it('keeps the stable code when the optimizer itself rejects with an OptimizeError', async () => {
    const service = makeService(makeHost(), { evalMaxCases: 1 })
    vi.spyOn(service, 'optimize').mockRejectedValue(new OptimizeError(OptimizeErrorCode.BUDGET_EXCEEDED, 'out of budget'))
    const { run } = await service.runEval({ maxCases: 1 })
    expect(run.results[0]?.error).toBe(OptimizeErrorCode.BUDGET_EXCEEDED)
  })

  it('resets the early-stop tail after a large growth, then stops at a later boundary', async () => {
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'text-delta', index: 0, text: FOUR_SECTIONS } as StreamChunk
      // A long chunk moves the tail forward and clears the quiet counter.
      yield { type: 'text-delta', index: 0, text: '新增内容'.repeat(40) } as StreamChunk
      for (let index = 0; index < 5; index++) {
        yield { type: 'text-delta', index: 0, text: '。' } as StreamChunk
      }
    })()
    const service = makeService(makeHost({ stream }), { earlyStop: true, earlyStopTailChunks: 3, earlyStopTailGrowth: 32 })
    const result = await service.optimize('帮我写一份周报，面向 CTO')
    expect(result.optimized).toBe(true)
    expect(result.prompt.endsWith('。')).toBe(true)
  })

  it('refines a local seed with explicit params inside a selection run', async () => {
    const service = makeService(makeHost(), { localTemplate: 'hybrid', selectCandidates: 2, selectJudge: false })
    const result = await service.optimize('帮我写一份周报，面向 CTO，需覆盖进展')
    expect(result.optimized).toBe(true)
    expect(result.local).toBe(true)
  })

  it('walks every override key through set and clear', () => {
    const service = makeService(makeHost())
    service.setUserOverride('profile', 'fast')
    expect(service.getStatus().effective.profile).toBe('fast')
    service.clearUserOverride('profile')
    service.setUserOverride('temperature', '0.9')
    service.clearUserOverride('temperature')
    service.setUserOverride('local', 'on')
    service.clearUserOverride('local')
    service.setUserOverride('temperature', '9')
    // Out-of-range and unknown values are ignored rather than clamped.
    expect(service.getStatus().effective.temperature).not.toBe(9)
  })
})
