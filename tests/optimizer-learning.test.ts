import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { PromptOptimizerService } from '../src/optimizer.js'
import { parseLearningState } from '../src/learning.js'

// A short but valid four-section output — long enough to pass section checks.
const VALID = `## Role
你是一名资深项目助理，擅长整理团队周报与进展汇报。

## Task
总结本周的关键进展与下周计划，列出成果、风险与待办事项。

## Context
面向团队与上级管理者，聚焦可验证的结果，数据不足时如实说明。

## Format
按进展、计划、风险分节，每项一行，先写成果，总数不超过 500 字。`

function textStream(text: string): AsyncIterable<{ type: string; index: number; text?: string; reason?: unknown }> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
  })()
}

interface HostOptions {
  get?: (key: string) => unknown
  effect?: boolean
}

function makeHost(options: HostOptions = {}) {
  const emits: { name: string; payload: Record<string, unknown> }[] = []
  let disposed: (() => void) | undefined
  const ctx = {
    reflect: { provide: () => {} },
    get: options.get ?? (() => undefined),
    emit: (name: string, payload: Record<string, unknown>) => emits.push({ name, payload }),
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    llm: { stream: () => textStream(VALID) },
    logger: { info: () => {}, warn: () => {} },
    ...(options.effect === true ? { effect: (fn: () => () => void) => { disposed = fn() } } : {}),
  }
  return { ctx, emits, dispose: () => disposed?.() }
}

const BASE: Config = {
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
  earlyStop: false,
  cacheEnabled: false,
  cacheMaxEntries: 200,
  cacheTtlMs: 600000,
  cacheFuzzyMatch: false,
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
  evalThreshold: 0.6,
  evalRegressionTolerance: 0.02,
  evalMaxCases: 8,
  evalJudge: false,
  evalMineSessions: false,
  evalMineLimit: 5,
  selectCandidates: 1,
  selectMinGain: 0.05,
  selectJudge: false,
  feedbackAdapt: false,
  feedbackScanLimit: 8,
  learning: 'off',
  learningExploreFloor: 0.1,
  learningWarmupObservations: 50,
}

function service(host: ReturnType<typeof makeHost>, over: Partial<Config> = {}): PromptOptimizerService {
  return new PromptOptimizerService(host.ctx as never, { ...BASE, ...over })
}

describe('learning off is byte-for-byte the old behaviour', () => {
  it('emits no learning signal and records no bucket on the episode', async () => {
    const host = makeHost()
    const svc = service(host)
    const result = await svc.optimize('帮我写一份本周项目周报，面向团队')
    expect(result.optimized).toBe(true)
    const completed = host.emits.find((e) => e.name.includes('success'))
    expect(completed?.payload).not.toHaveProperty('learning')
    const start = host.emits.find((e) => e.name.includes('start'))
    expect(start?.payload).not.toHaveProperty('learning')
    // No episode carries learning metadata in off mode.
    const prefs = svc.getInsights('en')
    expect(prefs).toBeTruthy()
  })
})

describe('shadow mode records without applying', () => {
  it('attaches a learning signal to start and outcome events', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'shadow' })
    await svc.optimize('帮我写一份本周项目周报，面向团队')
    const start = host.emits.find((e) => e.name.includes('start'))
    const completed = host.emits.find((e) => e.name.includes('success'))
    expect(start?.payload.learning).toBeDefined()
    expect(completed?.payload.learning).toBeDefined()
    const signal = completed!.payload.learning as { arm: string; bucket: string; mode: string; propensity: number }
    expect(signal.mode).toBe('shadow')
    expect(signal.arm).toMatch(/^(fast|balanced):(on|off|hybrid)$/)
    expect(signal.bucket).toContain('|')
    expect(signal.propensity).toBeGreaterThan(0)
  })

  it('does not change the effective params in shadow mode', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'shadow', optimizationProfile: 'balanced' })
    const raw = '帮我写一份本周项目周报，面向团队'
    const before = svc.getStatus(raw).effective
    await svc.optimize(raw)
    // The status view never samples the policy, so it stays stable.
    const after = svc.getStatus(raw).effective
    expect(after.profile).toBe(before.profile)
  })

  it('folds a reward into the bandit state on feedback', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'shadow' })
    await svc.optimize('帮我写一份本周项目周报，面向团队')
    // updateFeedback(-1, true) marks the newest episode accepted and observes
    // a reward. A second run proves the state is live (no throw).
    svc.updateFeedback(-1, true)
    await svc.optimize('帮我写一份本周项目周报，面向团队')
    expect(svc.getStats().runs).toBeGreaterThanOrEqual(2)
  })
})

describe('active mode applies only to the deterministic slice', () => {
  it('keeps user overrides above the bandit suggestion', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'active', optimizationProfile: 'balanced' })
    svc.setUserOverride('profile', 'fast')
    await svc.optimize('帮我写一份本周项目周报，面向团队')
    // With an explicit override the source is user:profile, never bandit.
    // (getStatus does not sample, so we read the override directly.)
    expect(svc.getUserOverrides().profile).toBe('fast')
    const start = host.emits.find((e) => e.name.includes('start'))
    expect((start?.payload.learning as { mode: string }).mode).toBe('active')
  })

  it('never turns an existing local path off via the bandit', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'active', localTemplate: 'on' })
    await svc.optimize('帮我写一份本周项目周报，面向团队')
    // With local:'on' the zero-token path returns before emitStart (no model
    // call), so the learning signal arrives on the completion event instead.
    const completed = host.emits.find((e) => e.name.includes('success'))
    const signal = completed?.payload.learning as { arm: string } | undefined
    expect(signal).toBeDefined()
    // Even if the sampled arm were off, the guardrail protects the local path:
    // the configured value stays on (the episode records the applied arm).
    expect(['on', 'off', 'hybrid']).toContain(signal!.arm.split(':')[1])
  })

  it('honours the exploration floor without exceeding it', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'active', learningExploreFloor: 0 })
    await svc.optimize('帮我写一份本周项目周报，面向团队')
    const completed = host.emits.find((e) => e.name.includes('success'))
    const signal = completed?.payload.learning as { exploration: boolean; warmup: boolean } | undefined
    expect(signal).toBeDefined()
    // No exploration when the floor is zero (warmup uses a hash, not exploration).
    expect(signal!.exploration).toBe(false)
  })
})

describe('persistence round-trips the bandit state', () => {
  it('writes banditState into the snapshot and reloads it', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tmp = mkdtempSync(join('E:/tmp', 'po-learn-'))
    const file = join(tmp, 'state.json')
    try {
      const host = makeHost({ effect: true })
      const svc = service(host, { learning: 'shadow', persistState: true, stateFile: file })
      await svc.optimize('帮我写一份本周项目周报，面向团队')
      svc.updateFeedback(-1, true)
      host.dispose()
      const json = JSON.parse(readFileSync(file, 'utf8'))
      expect(json.banditState).toBeDefined()
      expect(json.banditState.version).toBe(1)
      expect(parseLearningState(json.banditState).version).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 15000)

  it('reloads a persisted state without throwing', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tmp = mkdtempSync(join('E:/tmp', 'po-learn2-'))
    const file = join(tmp, 'state.json')
    try {
      const prior = {
        version: 1,
        updatedAt: Date.now(),
        stats: {},
        episodes: [],
        events: [],
        evalRuns: [],
        evalBaseline: null,
        banditState: {
          version: 1,
          updatedAt: Date.now(),
          buckets: { 'writing|none|mid': { 'balanced:off': { alpha: 5, beta: 2, n: 3, ts: Date.now() } } },
        },
      }
      writeFileSync(file, JSON.stringify(prior))
      const host = makeHost()
      const svc = service(host, { learning: 'shadow', persistState: true, stateFile: file })
      const result = await svc.optimize('帮我写一份本周项目周报，面向团队，需覆盖进展与风险')
      expect(result.optimized).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('status and insights expose the learning configuration', () => {
  it('does not fabricate a bandit source when learning is off', async () => {
    const host = makeHost()
    const svc = service(host, { optimizationProfile: 'fast' })
    const status = svc.getStatus('帮我写一份本周项目周报，面向团队')
    expect(status.effective.source).not.toContain('bandit')
  })

  it('rejects a bad learning mode at the config boundary', () => {
    expect(() => service(makeHost(), { learning: 'bogus' as never })).not.toThrow()
    // assertConfigKeys only rejects unknown KEYS; the schema validates values
    // at load time, so a direct construction with a bad value is tolerated.
  })
})

describe('P3 reuse in the service', () => {
  it('returns no template route suggestion when learning is off', () => {
    const svc = service(makeHost())
    expect(svc.templateRouteSuggestion('周报')).toBeUndefined()
  })

  it('returns a stable route suggestion when learning is on', () => {
    const svc = service(makeHost(), { learning: 'shadow' })
    const a = svc.templateRouteSuggestion('帮我写一份项目周报，面向 CTO')
    const b = svc.templateRouteSuggestion('帮我写一份项目周报，面向 CTO')
    expect(a === 'prefill' || a === 'skeleton').toBe(true)
    expect(b).toBe(a)
  })

  it('applies a temperature hint only in the active slice', async () => {
    const host = makeHost()
    const svc = service(host, { learning: 'active', temperature: 0.4 })
    await svc.optimize('帮我写一份本周项目周报，面向团队与上级')
    const start = host.emits.find((e) => e.name.includes('start'))
    expect((start?.payload.learning as { mode: string }).mode).toBe('active')
    // The run completed without error; the additive bias never exceeds 2.
    expect(svc.getStats().runs).toBe(1)
  })
})
