import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from '../src/optimizer.js'
import type { OptimizeOptions } from '../src/optimizer.js'
import type { Config } from '../src/config.js'

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
  senseNeedsSeparate: false,
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
  dreamInsightFeedback: false,
  classifier: 'heuristic',
  localTemplate: 'off',
  hybridAlignThreshold: 0.4,
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
  it('registers the /optimize, /auto-optimize, /optimizer-language and /optimize-stats commands', () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(commands.map((c) => c.name)).toEqual(['optimize', 'dream', 'auto-optimize', 'optimizer-language', 'optimize-stats', 'template'])
    const optimize = commands.find((c) => c.name === 'optimize')!
    expect(optimize.description).toContain('professional')
    expect(optimize.input?.hint).toBeTruthy()
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

describe('/auto-optimize command', () => {
  const auto = (commands: CommandDef[]) => commands.find((c) => c.name === 'auto-optimize')!

  it('reports status', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await auto(commands).handler(invocation('status'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
  })

  it('toggles on and off', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    expect(service.isAutoOptimizeAll()).toBe(false)
    expect(await auto(commands).handler(invocation('toggle'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:ON' })
    expect(service.isAutoOptimizeAll()).toBe(true)
    expect(await auto(commands).handler(invocation('toggle'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
    expect(service.isAutoOptimizeAll()).toBe(false)
  })

  it('accepts explicit on/off and rejects unknown arguments', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await auto(commands).handler(invocation('on'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:ON' })
    expect(service.isAutoOptimizeAll()).toBe(true)
    expect(await auto(commands).handler(invocation('off'))).toMatchObject({ kind: 'success', text: 'AUTO_OPTIMIZE:OFF' })
    expect(await auto(commands).handler(invocation('maybe'))).toMatchObject({ kind: 'error' })
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

describe('/optimizer-language command', () => {
  const lang = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimizer-language')!

  it('reports the auto default', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(await lang(commands).handler(invocation('status'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:AUTO' })
  })

  it('pins 英文/中文 and clears back to auto', async () => {
    const { commands, service } = makeService(() => textStream(FOUR_SECTIONS))
    expect(service.getMetaPromptLanguage()).toBe('auto')
    expect(await lang(commands).handler(invocation('英文'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:EN' })
    expect(service.getMetaPromptLanguage()).toBe('en')
    expect(await lang(commands).handler(invocation('中文'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:ZH' })
    expect(service.getMetaPromptLanguage()).toBe('zh')
    expect(await lang(commands).handler(invocation('auto'))).toMatchObject({ kind: 'success', text: 'META_LANGUAGE:AUTO' })
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
    expect(await lang(commands).handler(invocation('日文'))).toMatchObject({ kind: 'error' })
  })
})

describe('/optimize-stats command', () => {
  const stats = (commands: CommandDef[]) => commands.find((c) => c.name === 'optimize-stats')!

  it('reports the last run output tokens as a machine token', async () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    // Before any run the counters are zero.
    expect(await stats(commands).handler(invocation(''))).toMatchObject({ kind: 'success', text: 'OPTIMIZE_STATS:TOKENS:0|INPUT:0|CALLS:0|LASTMSCALL:0|LOCAL:0|REFINED:0|APPX:0' })
    const optimize = commands.find((c) => c.name === 'optimize')!
    await optimize.handler(invocation('帮我写周报'))
    const result = await stats(commands).handler(invocation(''))
    expect(result).toMatchObject({ kind: 'success' })
    const text = (result as { text: string }).text
    expect(text).toMatch(/OPTIMIZE_STATS:TOKENS:\d+\|INPUT:\d+\|CALLS:1\|LASTMSCALL:\d+\|LOCAL:\d+\|REFINED:\d+\|APPX:\d+/)
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
    expect(text).toContain('## Role')
    expect(text).toContain('## Task')
    expect(text).toContain('## Context')
    expect(text).toContain('## Format')
    // 预填版含抽取的核心动作（本地渲染，非占位符骨架）。
    expect(text).toContain('核心动作')
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
