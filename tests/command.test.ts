import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from '../src/optimizer.js'
import type { OptimizeOptions, OptimizeStats } from '../src/optimizer.js'
import type { Config } from '../src/config.js'
import { OptimizeError, OptimizeErrorCode } from '../src/errors.js'
import type { EvalComparison, EvalRun } from '../src/eval.js'

const FOUR_SECTIONS = `## Role
专家

## Task
写周报

## Context
团队周会

## Format
Markdown`

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
  metaPromptLanguage: 'auto',
  autoOptimize: false,
  autoOptimizePrefix: '/optimize ',
  minSectionChars: 0,
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
  evalThreshold: 0.6,
  evalRegressionTolerance: 0.02,
  evalMaxCases: 8,
  evalJudge: false,
  evalMineSessions: false,
  evalMineLimit: 5,
  // Best-of-N selection + host feedback signals (1.12.0): off/minimal by default.
  selectCandidates: 1,
  selectMinGain: 0.05,
  selectJudge: true,
  feedbackAdapt: true,
  feedbackScanLimit: 8,
  learning: 'off',
  learningExploreFloor: 0.1,
  learningWarmupObservations: 50,
}

function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

interface CommandDef {
  name: string
  description: string
  input?: { hint?: string }
  handler: (invocation: { commandId: unknown; agent: unknown; rawInput: string; signal: AbortSignal }) => Promise<unknown>
}

function makeService(makeStream: () => AsyncIterable<StreamChunk>, config: Config = DEFAULT_CONFIG): { service: PromptOptimizerService; commands: CommandDef[] } {
  const captured: CommandDef[] = []
  const ctx = {
    reflect: { provide: () => {} },
    get: () => undefined,
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: (def: CommandDef) => { captured.push(def); return () => {} } },
    llm: { stream: () => makeStream() },
  }
  const service = new PromptOptimizerService(ctx as never, config)
  if (captured.length === 0) throw new Error('no command registered')
  return { service, commands: captured }
}

const invocation = (rawInput: string) => ({
  commandId: CommandId('cmd-test'),
  agent: {},
  rawInput,
  signal: new AbortController().signal,
})

describe('registerOptimizeCommand', () => {
  it('registers the /optimize, /optimize-eval and /template commands', () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(commands.map((c) => c.name)).toEqual(['optimize', 'optimize-eval', 'template'])
    const optimize = commands.find((c) => c.name === 'optimize')!
    expect(optimize.description).toContain('Optimize')
    expect(optimize.input?.hint).toBeTruthy()
    const evalCommand = commands.find((c) => c.name === 'optimize-eval')!
    expect(evalCommand.description).toContain('golden set')
    expect(evalCommand.input?.hint).toContain('baseline')
  })

  it('returns the optimized prompt on success', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const result = await commands.find((c) => c.name === 'optimize')!.handler(invocation('帮我写周报'))
    expect(result).toMatchObject({ kind: 'success', text: FOUR_SECTIONS })
  })

  it('returns an error for an empty instruction', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const result = await commands.find((c) => c.name === 'optimize')!.handler(invocation('   '))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('请提供') })
  })

  it('returns an error when optimization falls back', async () => {
    const { commands } = makeService(() => textStream('没有四段'))
    const result = await commands.find((c) => c.name === 'optimize')!.handler(invocation('x'))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('missing one or more') })
  })

  it('contains the error message when the model call throws', async () => {
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } } as StreamChunk
    })()
    const { commands } = makeService(stream)
    const result = await commands.find((c) => c.name === 'optimize')!.handler(invocation('x'))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('boom') })
  })

  it('maps a timeout OptimizeError to the stable Chinese message', async () => {
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      const reason = new TimeoutReason(PROMPT_OPTIMIZER_TIMEOUT_CODE, 10)
      yield { type: 'text-delta', index: 0, text: '' } as StreamChunk
      throw Object.assign(new Error('aborted'), { reason })
    })()
    const { commands } = makeService(stream)
    const result = await commands.find((c) => c.name === 'optimize')!.handler(invocation('x'))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('超时') })
  })

  it('maps a no-route OptimizeError to the stable Chinese message', async () => {
    const captured: CommandDef[] = []
    const ctx = {
      reflect: { provide: () => {} },
      get: () => undefined,
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      commands: { register: (def: CommandDef) => { captured.push(def); return () => {} } },
      llm: { stream: () => textStream(FOUR_SECTIONS) },
    }
    new PromptOptimizerService(ctx as never, { ...DEFAULT_CONFIG, provider: undefined, model: undefined })
    const result = await captured.find((c) => c.name === 'optimize')!.handler(invocation('x'))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('模型路由') })
  })
})

describe('/optimize command context awareness', () => {
  const sessionMessages = (texts: string[]) =>
    texts.map((text) => ({ content: [{ type: 'text', text }] }))

  it('gathers session context when contextAware is on', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS), { ...DEFAULT_CONFIG, contextAware: true })
    const captured: { text: string; options?: OptimizeOptions }[] = []
    vi.spyOn(service, 'optimize').mockImplementation(async (text: string, options?: OptimizeOptions) => {
      captured.push({ text, options })
      return { prompt: FOUR_SECTIONS, optimized: true, retries: 0 }
    })
    const handler = commands.find((c) => c.name === 'optimize')!
    const inv = invocation('帮我写周报')
    inv.agent = {
      session: { deriveMessages: () => sessionMessages(['第一轮：明确需求', '第二轮：预算 5 万']) },
    }
    const result = await handler.handler(inv)
    expect(result).toMatchObject({ kind: 'success', text: FOUR_SECTIONS })
    expect(captured[0]!.options?.context).toContain('第一轮：明确需求')
    // The command's own record (the last message) is dropped from the context.
    expect(captured[0]!.options?.context).not.toContain('帮我写周报')
  })

  it('does not gather context when contextAware is off', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const captured: { options?: OptimizeOptions }[] = []
    vi.spyOn(service, 'optimize').mockImplementation(async (_text: string, options?: OptimizeOptions) => {
      captured.push({ options })
      return { prompt: FOUR_SECTIONS, optimized: true, retries: 0 }
    })
    const handler = commands.find((c) => c.name === 'optimize')!
    const inv = invocation('帮我写周报')
    inv.agent = { session: { deriveMessages: () => sessionMessages(['上一轮']) } }
    await handler.handler(inv)
    expect(captured[0]!.options?.context).toBeUndefined()
  })

  it('degrades gracefully when the session API is absent', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const optimize = vi.spyOn(service, 'optimize')
    const handler = commands.find((c) => c.name === 'optimize')!
    // agent without a session: the command still succeeds without context.
    const result = await handler.handler(invocation('帮我写周报'))
    expect(result).toMatchObject({ kind: 'success', text: FOUR_SECTIONS })
    expect(optimize).toHaveBeenCalledWith('帮我写周报', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})

describe('/optimize --auto flag', () => {
  const optimize = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimize')!

  it('reports status', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await optimize(commands).handler(invocation('--auto status'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
  })

  it('toggles on and off', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    expect(service.isAutoOptimizeAll()).toBe(false)
    expect(await optimize(commands).handler(invocation('--auto toggle'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:ON' })
    expect(service.isAutoOptimizeAll()).toBe(true)
    expect(await optimize(commands).handler(invocation('--auto toggle'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
    expect(service.isAutoOptimizeAll()).toBe(false)
  })

  it('accepts explicit on/off and rejects unknown arguments', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await optimize(commands).handler(invocation('--auto on'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:ON' })
    expect(service.isAutoOptimizeAll()).toBe(true)
    expect(await optimize(commands).handler(invocation('--auto off'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
    expect(await optimize(commands).handler(invocation('--auto maybe'))).toMatchObject({ kind: 'error' })
  })

  it('combines with the static config flag', async () => {
    const ctx = {
      reflect: { provide: () => {} },
      get: () => undefined,
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      commands: { register: () => () => {} },
      llm: { stream: () => textStream(FOUR_SECTIONS) },
    }
    const service = new PromptOptimizerService(ctx as never, { ...DEFAULT_CONFIG, autoOptimizeAll: true })
    expect(service.isAutoOptimizeAll()).toBe(true)
    service.setAutoOptimizeAll(false)
    expect(service.isAutoOptimizeAll()).toBe(true) // static flag still holds
  })
})

describe('/optimize --language flag', () => {
  const optimize = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimize')!

  it('reports the auto default', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await optimize(commands).handler(invocation('--language status'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:AUTO' })
  })

  it('pins 英文/中文 and clears back to auto', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    expect(service.getMetaPromptLanguage()).toBe('auto')
    expect(await optimize(commands).handler(invocation('--language 英文'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:EN' })
    expect(service.getMetaPromptLanguage()).toBe('en')
    expect(await optimize(commands).handler(invocation('--language 中文'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:ZH' })
    expect(service.getMetaPromptLanguage()).toBe('zh')
    expect(await optimize(commands).handler(invocation('--language auto'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:AUTO' })
    expect(service.getMetaPromptLanguage()).toBe('auto')
  })

  it('falls back to the config when no runtime override is set', async () => {
    const ctx = {
      reflect: { provide: () => {} },
      get: () => undefined,
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      commands: { register: () => () => {} },
      llm: { stream: () => textStream(FOUR_SECTIONS) },
    }
    const service = new PromptOptimizerService(ctx as never, { ...DEFAULT_CONFIG, metaPromptLanguage: '英文' })
    expect(service.getMetaPromptLanguage()).toBe('en')
  })

  it('rejects unknown arguments', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await optimize(commands).handler(invocation('--language 日文'))).toMatchObject({ kind: 'error' })
  })
})

describe('/optimize --stats flag', () => {
  const optimize = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimize')!

  it('reports the last run output tokens as a machine token', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    // Before any run the counters are zero. The trailing SELECT*/FEEDBACK*
    // groups are 1.12.0 (best-of-N + host signals) and the MODEL*/PROVIDER*
    // group is 1.13.0 (the route the last run called, 1.13.0) — appended,
    // never interleaved, so a client parsing the leading fields keeps working.
    expect(await optimize(commands).handler(invocation('--stats'))).toMatchObject({
      kind: 'success',
      text: 'OPTIMIZE_STATS:TOKENS:0|INPUT:0|CALLS:0|LASTMSCALL:0|LOCAL:0|REFINED:0|REALIN:0|REALOUT:0|REALCALLS:0|CACHER:0|CACHEW:0|USAGECALLS:0'
        + '|SELRUNS:0|SELGAINS:0|SELCAND:0|SELCHOSEN:0|SELSCORE:0|SELGATE:0'
        + '|FBSESSIONS:0|FBPOS:0|FBNEG:0|FBBIAS:0'
        + '|MODEL:|PROVIDER:|EFFORT:',
    })
    await optimize(commands).handler(invocation('帮我写周报'))
    const result = await optimize(commands).handler(invocation('--stats'))
    expect(result).toMatchObject({ kind: 'success' })
    const text = (result as { text: string }).text
    expect(text).toMatch(/OPTIMIZE_STATS:TOKENS:\d+\|INPUT:\d+\|CALLS:1\|LASTMSCALL:\d+\|LOCAL:\d+\|REFINED:\d+/)
    expect(text).toContain('|SELRUNS:0|')
    expect(text).toContain('|FBSESSIONS:0|')
    // The route the run called, in the machine-readable view too.
    expect(text).toMatch(/\|MODEL:.+\|PROVIDER:.+\|EFFORT:/)
  })

  it('reports the best-of-N configuration when selection is off (--select)', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const result = await optimize(commands).handler(invocation('--select')) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('selectCandidates=1')
  })

  it('reports no host feedback service or an empty ledger (--feedback)', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const result = await optimize(commands).handler(invocation('--feedback')) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('宿主未提供 messageFeedback')
    expect(result.text).toContain('FEEDBACK:SESSIONS:0|POSITIVE:0|NEGATIVE:0|BIAS:0')
  })
})

describe('/template quick command (1.5.1)', () => {
  it('returns a fillable scene template for a matched scene', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const tmpl = commands.find((c) => c.name === 'template')!
    const res = (await tmpl.handler(invocation('周报'))) as { kind: string; text: string }
    expect(res.kind).toBe('success')
    const text = res.text
    expect(text).toContain('## Role')
    expect(text).toContain('## Task')
    expect(text).toContain('## Format')
    expect(text).toContain('场景骨架')
  })

  it('errors on an unknown scene and on an empty argument', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const tmpl = commands.find((c) => c.name === 'template')!
    const a = (await tmpl.handler(invocation('不存在的场景xyz'))) as { kind: string }
    const b = (await tmpl.handler(invocation(''))) as { kind: string }
    expect(a.kind).toBe('error')
    expect(b.kind).toBe('error')
  })

  it('returns a pre-filled template for scene + instruction (1.5.6 方案 B)', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const tmpl = commands.find((c) => c.name === 'template')!
    // 「周报 总结本周进展」→ 场景周报 + 指令 → 本地预填版（零模型调用）。
    const res = (await tmpl.handler(invocation('周报 总结本周进展和下周计划'))) as { kind: string; text: string }
    expect(res.kind).toBe('success')
    const text = res.text
    // No section headers in plain mode.
    expect(text).not.toContain('## Role')
    expect(text).not.toContain('## Task')
    expect(text).not.toContain('## Context')
    expect(text).not.toContain('## Format')
    // 预填版为完整成品（本地渲染，非占位符骨架）。
    expect(text).toContain('撰写周报')
    expect(text).not.toContain('{{')
  })

  it('falls back to the skeleton when the instruction has no local signals (1.5.6)', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const tmpl = commands.find((c) => c.name === 'template')!
    // 场景 + 无信号的指令 → 门控拒绝 → 回退骨架 + 提示。
    const res = (await tmpl.handler(invocation('周报 随便'))) as { kind: string; text: string }
    expect(res.kind).toBe('success')
    expect(res.text).toContain('场景骨架')
    expect(res.text).toContain('未识别可本地填充的信号')
  })
})

describe('/template presentation scene (1.6.4)', () => {
  it('matches the 演示 scene and renders the presentation skeleton', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const tmpl = commands.find((c) => c.name === 'template')!
    const r = (await tmpl.handler(invocation('演示'))) as { kind: string; text: string }
    expect(r.kind).toBe('success')
    expect(r.text).toContain('明确受众与目的')
  })
})

/** A complete stats snapshot so `--stats` can be driven field by field. */
function statsFixture(over: Partial<OptimizeStats> = {}): OptimizeStats {
  return {
    runs: 2, success: 2, failed: 0, cached: 0, local: 0, refined: 0,
    totalDurationMs: 200, maxDurationMs: 150, lastOutputTokens: 42, lastCallMs: 100,
    avgCallMs: 100, maxCallMs: 150, totalCallMs: 200, callCount: 2,
    lastRunCalls: 1, lastInputTokens: 30, usageCalls: 2,
    inputTokens: 20, outputTokens: 80, cacheReadTokens: 5, cacheWriteTokens: 0,
    reasoningTokens: 3,
    lastRunUsage: { calls: 2, inputTokens: 20, outputTokens: 80, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 3 },
    lastRunRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    selectRuns: 2, selectGains: 1, lastSelectCandidates: 3, lastSelectChosen: 2,
    lastSelectScore: 0.9, lastSelectGate: 3,
    feedbackSessions: 1, feedbackPositive: 3, feedbackNegative: 1, feedbackBiasApplied: -0.1,
    ...over,
  }
}

function evalRunFixture(over: Partial<EvalRun> = {}): EvalRun {
  return {
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    cases: 2, optimized: 2, deterministicPass: 2, scored: 2,
    injectionCases: 0, leaked: 0, aggregate: 0.85, deterministicPassRate: 1,
    perDimension: { clarity: 4.5 }, billedInputTokens: 120, outputTokens: 240,
    mined: false, results: [],
    ...over,
  }
}

function comparisonFixture(over: Partial<EvalComparison> = {}): EvalComparison {
  return { baseline: 0.8, current: 0.85, delta: 0.05, threshold: 0.6, verdict: 'pass', ...over }
}

describe('/optimize branch matrix', () => {
  const optimize = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimize')!.handler

  it('treats a missing, non-deriving, empty or throwing session as "no context"', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS), { ...DEFAULT_CONFIG, contextAware: true })
    const spy = vi.spyOn(service, 'optimize').mockResolvedValue({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 })
    const handler = optimize(commands)
    const variants: unknown[] = [
      undefined,
      {},
      { session: {} },
      { session: { deriveMessages: () => [] } },
      { session: { deriveMessages: () => [{ content: [{ type: 'text', text: 'only the command itself' }] }] } },
      { session: { deriveMessages: () => { throw new Error('session boom') } } },
    ]
    for (const agent of variants) {
      const result = await handler({ ...invocation('写周报'), agent }) as { kind: string }
      expect(result.kind).toBe('success')
    }
    for (const call of spy.mock.calls) expect(call[1]?.context).toBeUndefined()

    // A two-message session contributes the PRIOR message only: the last one is
    // the command line being executed and must not be fed back as context.
    await handler({
      ...invocation('写周报'),
      agent: {
        session: {
          deriveMessages: () => [
            { content: [{ type: 'text', text: '第一轮：明确需求' }] },
            { content: [{ type: 'text', text: '第二轮：/optimize 写周报' }] },
          ],
        },
      },
    })
    const last = spy.mock.calls.at(-1)
    expect(last?.[1]?.context).toContain('第一轮')
    expect(last?.[1]?.context).not.toContain('/optimize 写周报')
  })

  it('passes an UNKNOWN OptimizeError message through but maps stable codes to text', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const spy = vi.spyOn(service, 'optimize')
    spy
      .mockRejectedValueOnce(new OptimizeError(OptimizeErrorCode.UNKNOWN, 'provider said 429'))
      .mockRejectedValueOnce(new OptimizeError(OptimizeErrorCode.TIMEOUT, 'deadline'))
      .mockRejectedValueOnce('a bare string, not an Error')
    const handler = optimize(commands)

    expect(await handler(invocation('x'))).toMatchObject({ kind: 'error', text: 'provider said 429' })
    expect(await handler(invocation('x'))).toMatchObject({ kind: 'error', text: expect.stringContaining('超时') })
    expect(await handler(invocation('x'))).toMatchObject({ kind: 'error', text: expect.stringContaining('a bare string') })
  })

  it('reports the fallback default when a failed result carries no error text', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'optimize').mockResolvedValue({ prompt: '原文', optimized: false, retries: 1 })
    const result = await optimize(commands)(invocation('x')) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toBe('prompt-optimize: 优化失败')
  })

  it('reports provider usage, selection, feedback and the route in --stats', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'getStats').mockReturnValue(statsFixture())
    const result = await optimize(commands)(invocation('--stats')) as { kind: string; text: string }
    // REALIN = uncached 20 + cache read 5 + write 0
    expect(result.text).toContain('REALIN:25|REALOUT:80|REALCALLS:2')
    expect(result.text).toContain('SELRUNS:2|SELGAINS:1|SELCAND:3|SELCHOSEN:2|SELSCORE:0.9|SELGATE:3')
    expect(result.text).toContain('FBSESSIONS:1|FBPOS:3|FBNEG:1|FBBIAS:-0.1')
    expect(result.text).toContain('MODEL:deepseek-v4-flash|PROVIDER:deepseek-official|EFFORT:high')
  })

  it('renders --feedback in English and survives a failing scan', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    service.setMetaPromptLanguage('en')
    vi.spyOn(service, 'scanFeedback').mockRejectedValue(new Error('host refused'))
    const result = await optimize(commands)(invocation('--feedback')) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('FEEDBACK:SESSIONS:0')
  })

  it('explains --select both when a selection ran and when it produced no detail', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'getStats').mockReturnValue(statsFixture({ lastSelectScore: 0, lastSelectChosen: 1 }))
    vi.spyOn(service, 'selectSummary').mockReturnValueOnce(undefined).mockReturnValue('  #1 won')
    const handler = optimize(commands)

    const zh = await handler(invocation('--select')) as { text: string }
    expect(zh.text).toContain('上次择优 1/3')
    expect(zh.text).toContain('n/a')
    expect(zh.text).not.toContain('#1 won')

    const en = await (async () => {
      service.setMetaPromptLanguage('en')
      return handler(invocation('--select')) as Promise<{ text: string }>
    })()
    expect(en.text).toContain('last selection 1/3')
    expect(en.text).toContain('#1 won')
  })

  it('rejects unknown --auto and --language arguments and reports status', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = optimize(commands)
    expect(await handler(invocation('--auto status'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
    expect(await handler(invocation('--auto maybe'))).toMatchObject({ kind: 'error', text: expect.stringContaining('on | off | toggle | status') })
    expect(await handler(invocation('--language status'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:AUTO' })
    expect(await handler(invocation('--language klingon'))).toMatchObject({ kind: 'error', text: expect.stringContaining('--language') })
  })

  it('accepts and rejects every --set-* override', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = optimize(commands)
    const text = async (raw: string) => (await handler(invocation(raw)) as { kind: string; text: string })

    expect(await text('--set-profile fast')).toMatchObject({ kind: 'success', text: 'SET_PROFILE:FAST' })
    expect(await text('--set-profile balanced')).toMatchObject({ kind: 'success', text: 'SET_PROFILE:BALANCED' })
    expect(await text('--set-profile clear')).toMatchObject({ kind: 'success', text: 'SET_PROFILE:CLEAR' })
    expect(await text('--set-profile turbo')).toMatchObject({ kind: 'error' })

    expect(await text('--set-local on')).toMatchObject({ kind: 'success', text: 'SET_LOCAL:ON' })
    expect(await text('--set-local hybrid')).toMatchObject({ kind: 'success', text: 'SET_LOCAL:HYBRID' })
    expect(await text('--set-local clear')).toMatchObject({ kind: 'success', text: 'SET_LOCAL:CLEAR' })
    expect(await text('--set-local always')).toMatchObject({ kind: 'error' })

    expect(await text('--set-temperature 0.7')).toMatchObject({ kind: 'success', text: 'SET_TEMPERATURE:0.7' })
    expect(await text('--set-temperature clear')).toMatchObject({ kind: 'success', text: 'SET_TEMPERATURE:CLEAR' })
    expect(await text('--set-temperature 9')).toMatchObject({ kind: 'error', text: expect.stringContaining('0.0-2.0') })
    expect(await text('--set-temperature warm')).toMatchObject({ kind: 'error' })

    // The overrides are real state, not just echoed tokens.
    expect(service.getUserOverrides()).toEqual({})
  })

  it('renders --insights and --status in both languages', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = optimize(commands)
    const zh = await handler(invocation('--insights')) as { kind: string; text: string }
    expect(zh.kind).toBe('success')
    service.setMetaPromptLanguage('en')
    const en = await handler(invocation('--insights')) as { text: string }
    expect(en.text).not.toBe(zh.text)

    const status = await handler(invocation('--status profile=fast')) as { kind: string; text: string }
    expect(status.kind).toBe('success')
    expect(status.text.startsWith('STATUS_OK\n')).toBe(true)
    expect(status.text).toContain('prompt-optimizer status')
  })
})

describe('/optimize-eval branch matrix', () => {
  const evalCommand = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimize-eval')!.handler

  it('asks for a first run when nothing was measured yet', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    for (const raw of ['', 'show']) {
      expect(await evalCommand(commands)(invocation(raw))).toMatchObject({
        kind: 'success',
        text: expect.stringContaining('还没有评测记录'),
      })
    }
  })

  it('reports an empty history and a populated one, with scores and labels', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = evalCommand(commands)
    expect(await handler(invocation('list'))).toMatchObject({ kind: 'success', text: expect.stringContaining('还没有评测记录。') })

    vi.spyOn(service, 'getEvalRuns').mockReturnValue([
      evalRunFixture({ aggregate: undefined, label: 'nightly' }),
      evalRunFixture({ aggregate: 0.9 }),
    ])
    const list = await handler(invocation('list')) as { text: string }
    expect(list.text).toContain('最近 2 次评测')
    expect(list.text).toContain('n/a')
    expect(list.text).toContain('nightly')
  })

  it('shows the latest run with and without a baseline comparison', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = evalCommand(commands)
    vi.spyOn(service, 'getEvalSummary')
      .mockReturnValueOnce({ last: evalRunFixture(), baseline: undefined, comparison: undefined })
      .mockReturnValueOnce({ last: evalRunFixture(), baseline: evalRunFixture(), comparison: comparisonFixture() })
    const without = await handler(invocation('show')) as { text: string }
    expect(without.text).toContain('🧪 评测')
    expect(without.text).not.toContain('通过：')
    service.setMetaPromptLanguage('en')
    const withBase = await handler(invocation('show')) as { text: string }
    expect(withBase.text).toContain('✅ Pass')
  })

  it('lists the rubric and the case ids in both languages', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = evalCommand(commands)
    const zh = await handler(invocation('rubric')) as { text: string }
    expect(zh.text).toContain('评测维度')
    const all = await handler(invocation('cases --all')) as { text: string }
    expect(all.text).toContain('全部用例')
    expect(all.text).toContain('[core]')
    service.setMetaPromptLanguage('en')
    const en = await handler(invocation('cases')) as { text: string }
    expect(en.text).toContain('用例')
  })

  it('records a baseline only when there is a run to record', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = evalCommand(commands)
    vi.spyOn(service, 'setEvalBaseline').mockReturnValueOnce(undefined).mockReturnValueOnce(evalRunFixture({ aggregate: undefined }))
    expect(await handler(invocation('baseline'))).toMatchObject({ kind: 'error', text: expect.stringContaining('没有可记录') })
    expect(await handler(invocation('baseline nightly'))).toMatchObject({
      kind: 'success',
      text: 'EVAL_BASELINE:SET:n/a|CASES:2',
    })
  })

  it('rejects an unknown sub-command with the usage line', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await evalCommand(commands)(invocation('frobnicate'))).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('用法: /optimize-eval run'),
    })
  })

  it('returns a success result for a passing run and an error result for a regression', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = evalCommand(commands)
    const spy = vi.spyOn(service, 'runEval')
    spy.mockResolvedValueOnce({ run: evalRunFixture(), comparison: comparisonFixture() })
    const pass = await handler(invocation('run nightly --all --mine')) as { kind: string; text: string }
    expect(pass.kind).toBe('success')
    expect(pass.text).toContain('EVAL|')
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ all: true, mine: true, label: 'nightly' })

    spy.mockResolvedValueOnce({
      run: evalRunFixture({ aggregate: 0.4 }),
      comparison: comparisonFixture({ current: 0.4, delta: -0.45, verdict: 'regress' }),
    })
    const regress = await handler(invocation('run')) as { kind: string; text: string }
    expect(regress.kind).toBe('error')
    expect(regress.text).toContain('VERDICT:REGRESS')
  })

  it('maps a run failure to the stable text and keeps UNKNOWN messages verbatim', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = evalCommand(commands)
    const spy = vi.spyOn(service, 'runEval')
    spy
      .mockRejectedValueOnce(new OptimizeError(OptimizeErrorCode.UNKNOWN, 'judge exploded'))
      .mockRejectedValueOnce(new OptimizeError(OptimizeErrorCode.NO_MODEL_ROUTE, 'no route'))
      .mockRejectedValueOnce('kaboom')
    expect(await handler(invocation('run'))).toMatchObject({ kind: 'error', text: 'judge exploded' })
    expect(await handler(invocation('run'))).toMatchObject({ kind: 'error', text: expect.stringContaining('模型路由') })
    expect(await handler(invocation('run'))).toMatchObject({ kind: 'error', text: expect.stringContaining('kaboom') })
  })
})

describe('command surface in English mode', () => {
  const command = (commands: CommandDef[], name: string) => commands.find((c) => c.name === name)!

  it('explains that selection is off when only one candidate is drawn', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    service.setMetaPromptLanguage('en')
    vi.spyOn(service, 'getStats').mockReturnValue({ ...service.getStats(), lastSelectCandidates: 1 })
    const result = await command(commands, 'optimize').handler(invocation('--select'))
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('selection off (selectCandidates=1)') })
  })

  it('renders the English selection summary with and without a score', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    service.setMetaPromptLanguage('en')
    const stats = service.getStats()
    const spy = vi.spyOn(service, 'getStats')
    spy.mockReturnValueOnce({ ...stats, lastSelectCandidates: 3, lastSelectChosen: 2, lastSelectScore: 0.75, lastSelectGate: 3 })
    const scored = await command(commands, 'optimize').handler(invocation('--select')) as { text: string }
    expect(scored.text).toContain('last selection 2/3')
    expect(scored.text).toContain('score 0.75')
    spy.mockReturnValueOnce({ ...stats, lastSelectCandidates: 2, lastSelectChosen: 1, lastSelectScore: 0, lastSelectGate: 1 })
    const unscored = await command(commands, 'optimize').handler(invocation('--select')) as { text: string }
    // A zero score is "not measured", never "scored 0.00".
    expect(unscored.text).toContain('score n/a')
  })

  it('reports the auto-optimize switch state and toggles it', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = command(commands, 'optimize').handler
    service.setAutoOptimizeAll(false)
    expect(await handler(invocation('--auto status'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
    expect(await handler(invocation('--auto on'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:ON' })
    expect(await handler(invocation('--auto status'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:ON' })
  })

  it('answers --status with and without an explicit instruction in English', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    service.setMetaPromptLanguage('en')
    const handler = command(commands, 'optimize').handler
    const bare = await handler(invocation('--status')) as { text: string }
    expect(bare.text).toContain('STATUS_OK')
    expect(bare.text).toContain('Effective params')
    const scoped = await handler(invocation('--status 写周报')) as { text: string }
    expect(scoped.text).toContain('STATUS_OK')
  })

  it('lists eval runs and the rubric in English', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    service.setMetaPromptLanguage('en')
    vi.spyOn(service, 'getEvalRuns').mockReturnValue([evalRunFixture({ aggregate: 0.812, label: 'nightly' })])
    const handler = command(commands, 'optimize-eval').handler
    const list = await handler(invocation('list')) as { text: string }
    expect(list.text).toContain('最近 1 次评测')
    expect(list.text).toContain('0.812')
    const rubric = await handler(invocation('rubric')) as { text: string }
    expect(rubric.text).toContain('评测维度')
  })

  it('builds an English scene template and rejects an unknown head token', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    service.setMetaPromptLanguage('en')
    const handler = command(commands, 'template').handler
    const built = await handler(invocation('周报 帮我写一份本周周报')) as { kind: string; text: string }
    expect(built.kind).toBe('success')
    // The English render, not the Chinese one and not the skeleton fallback.
    expect(built.text).toContain('As a senior')
    expect(built.text).not.toContain('场景骨架参考')
    const unknown = await handler(invocation('未知场景 随便写点')) as { kind: string; text: string }
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('未识别场景')
  })

  it('renders a non-Error rejection from the optimizer by value', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'optimize').mockRejectedValue('plain boom')
    const result = await command(commands, 'optimize').handler(invocation('帮我写周报'))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('plain boom') })
  })

  it('skips context when deriveMessages returns nothing', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS), { ...DEFAULT_CONFIG, contextAware: true })
    const captured: (OptimizeOptions | undefined)[] = []
    vi.spyOn(service, 'optimize').mockImplementation(async (_text: string, options?: OptimizeOptions) => {
      captured.push(options)
      return { prompt: FOUR_SECTIONS, optimized: true, retries: 0 }
    })
    const inv = invocation('帮我写周报')
    inv.agent = { session: { deriveMessages: () => undefined } }
    await command(commands, 'optimize').handler(inv)
    expect(captured[0]?.context).toBeUndefined()
  })
})

describe('command result formatting edge cases', () => {
  it('renders an Error rejection by its message and a string by value', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = commands.find((c) => c.name === 'optimize')!.handler
    vi.spyOn(service, 'optimize').mockRejectedValueOnce(new Error('real failure'))
    expect(await handler(invocation('帮我写周报'))).toMatchObject({ kind: 'error', text: expect.stringContaining('real failure') })
  })

  it('prints a scored selection summary in Chinese', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'getStats').mockReturnValue({
      ...service.getStats(), lastSelectCandidates: 3, lastSelectChosen: 1, lastSelectScore: 0.66, lastSelectGate: 3,
    })
    const result = await commands.find((c) => c.name === 'optimize')!.handler(invocation('--select')) as { text: string }
    expect(result.text).toContain('0.66')
  })

  it('records a scored baseline with its aggregate', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'setEvalBaseline').mockReturnValue(evalRunFixture({ aggregate: 0.9 }))
    const result = await commands.find((c) => c.name === 'optimize-eval')!.handler(invocation('baseline nightly'))
    expect(result).toMatchObject({ kind: 'success', text: 'EVAL_BASELINE:SET:0.900|CASES:2' })
  })

  it('maps an Error thrown by the eval run to its message', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    vi.spyOn(service, 'runEval').mockRejectedValueOnce(new Error('grader crashed'))
    const result = await commands.find((c) => c.name === 'optimize-eval')!.handler(invocation('run')) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('grader crashed')
  })
})

describe('optimize-eval advise (P4 offline advice)', () => {
  it('returns structured advice without any eval runs', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = commands.find((c) => c.name === 'optimize-eval')!.handler
    const result = await handler(invocation('advise')) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('暂无维度评分')
  })

  it('lists advise in the usage hint', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    const handler = commands.find((c) => c.name === 'optimize-eval')!.handler
    const result = await handler(invocation('unknown-subcommand')) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('advise')
  })
})
