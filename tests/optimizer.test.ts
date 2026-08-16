import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PromptOptimizerService } from '../src/optimizer.js'
import type { Config } from '../src/config.js'

const FOUR_SECTIONS = `## Role
你是一名资深产品经理。

## Task
分析需求并输出 PRD。

## Context
面向中小企业，预算有限。

## Format
Markdown 文档，不超过 500 字。`

const THREE_SECTIONS = `## Role
你是一名资深产品经理。

## Task
分析需求并输出 PRD。

## Context
面向中小企业，预算有限。`

const DEFAULT_CONFIG: Config = {
  temperature: 0.2,
  maxTokens: 1200,
  maxRetries: 1,
  maxInputChars: 4000,
  maxInputTokens: 3000,
  timeoutMs: 1000,
  outputLanguage: 'auto',
  autoOptimize: false,
  autoOptimizePrefix: '/optimize ',
  minSectionChars: 10,
  maxTokenRetryFactor: 1.5,
  retryTemperatureStep: 0.3,
  skipIfAlreadyOptimized: false,
  autoOptimizeAll: false,
  hookIncludeOriginal: false,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

/** Build a text-only chunk stream (delta-only, tolerated by BlockAssembler). */
function textStream(text: string, finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield finish
  })()
}

interface CtxStub {
  ctx: unknown
  streamCalls: GenerateOptions[]
  registerCalls: unknown[]
  sectionCalls: unknown[]
  commandCalls: unknown[]
  selection?: { provider: string; model: string; reasoningEffort?: string }
}

function makeCtx(streams: AsyncIterable<StreamChunk>[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)): CtxStub {
  const streamCalls: GenerateOptions[] = []
  const registerCalls: unknown[] = []
  const sectionCalls: unknown[] = []
  const commandCalls: unknown[] = []
  const state: CtxStub = { ctx: undefined, streamCalls, registerCalls, sectionCalls, commandCalls }
  const ctx = {
    reflect: { provide: () => {} },
    get: (key: string) => (key === 'agentDefaultModel' ? { currentSelection: () => state.selection } : undefined),
    tools: { register: (def: unknown) => { registerCalls.push(def); return () => {} } },
    systemPrompt: { section: (def: unknown) => { sectionCalls.push(def); return () => {} } },
    commands: { register: (def: unknown) => { commandCalls.push(def); return () => {} } },
    llm: {
      stream: (options: GenerateOptions) => {
        streamCalls.push(options)
        return Array.isArray(streams) ? streams[streamCalls.length - 1] ?? textStream('') : streams(options)
      },
    },
  }
  state.ctx = ctx
  return state
}

function makeService(state: CtxStub, config: Config = DEFAULT_CONFIG): PromptOptimizerService {
  return new PromptOptimizerService(state.ctx as never, config)
}

describe('PromptOptimizerService.optimize', () => {
  it('returns the optimized prompt on a well-formed model output', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('帮我写一份 PRD', { signal: new AbortController().signal })
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
    expect(result.retries).toBe(0)
    expect(result.error).toBeUndefined()
    // Route and sampling params forwarded to llm.stream.
    const options = state.streamCalls[0]
    expect(options.provider).toBe('deepseek-official')
    expect(options.model).toBe('deepseek-v4-flash')
    expect(options.temperature).toBe(0.2)
    expect(options.maxTokens).toBe(1200)
    expect(options.system).toContain('帮我写一份 PRD')
    // Tool and guidance registrations happened at construction.
    expect(state.registerCalls).toHaveLength(1)
    expect(state.sectionCalls).toHaveLength(1)
  })

  it('retries once when sections are missing, then succeeds', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('写个脚本')
    expect(result.optimized).toBe(true)
    expect(result.retries).toBe(1)
    expect(state.streamCalls).toHaveLength(2)
  })

  it('falls back to the original instruction after exhausting retries', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(THREE_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('原始指令原文')
    expect(result.optimized).toBe(false)
    expect(result.prompt).toBe('原始指令原文')
    expect(result.error).toMatch(/missing one or more required sections/)
    expect(result.retries).toBe(1)
    expect(state.streamCalls).toHaveLength(2)
  })

  it('rejects empty input loudly', async () => {
    const state = makeCtx([])
    const service = makeService(state)
    await expect(service.optimize('   ')).rejects.toThrow(/non-empty/)
    expect(state.streamCalls).toHaveLength(0)
  })

  it('truncates over-long input before calling the model', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxInputChars: 100 })
    await service.optimize('x'.repeat(5000))
    const system = state.streamCalls[0].system ?? ''
    expect(system).toContain('[原始指令已截断')
    expect(system).not.toContain('x'.repeat(200))
  })

  it('truncates over-budget input by estimated tokens', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxInputTokens: 5 })
    await service.optimize('你是一名产品经理，负责分析需求与输出 PRD')
    const system = state.streamCalls[0].system ?? ''
    expect(system).toContain('token')
    // The heuristic counts CJK as 1 token/char: with a budget of 5 the
    // truncated system must not contain the tail of the instruction.
    expect(system).not.toContain('输出 PRD')
  })

  it('includes a per-section breakdown on success', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('帮我写一份 PRD')
    expect(result.optimized).toBe(true)
    expect(result.sections).toHaveLength(4)
    expect(result.sections?.map((s) => s.name)).toEqual(['Role', 'Task', 'Context', 'Format'])
    expect(result.sections?.[0].content).toContain('产品经理')
  })

  it('resolves the route from agentDefaultModel when config has none', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    state.selection = { provider: 'custom-provider', model: 'custom-model', reasoningEffort: 'high' }
    const service = makeService(state, { ...DEFAULT_CONFIG, provider: undefined, model: undefined })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    const options = state.streamCalls[0]
    expect(options.provider).toBe('custom-provider')
    expect(options.model).toBe('custom-model')
    expect(options.reasoningEffort).toBe('high')
  })

  it('fails loudly when provider and model are configured separately', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, provider: 'p', model: undefined })
    await expect(service.optimize('x')).rejects.toThrow(/configured together/)
  })

  it('fails loudly when no route is available at all', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, provider: undefined, model: undefined })
    await expect(service.optimize('x')).rejects.toThrow(/no model route/)
  })

  it('fails loudly on unknown config keys at construction', () => {
    const state = makeCtx([])
    expect(() =>
      new PromptOptimizerService(state.ctx as never, { ...DEFAULT_CONFIG, typo: 1 } as never),
    ).toThrow(/unknown config key "typo"/)
  })

  it('surfaces the stable LlmError code on a terminal error finish', async () => {
    const state = makeCtx([
      textStream('', { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'RATE_LIMIT' } } }),
    ])
    const service = makeService(state)
    const error = await service.optimize('x').then(() => null, (e: Error & { code?: string }) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error & { code?: string }).code).toBe('RATE_LIMIT')
    expect((error as Error).message).toContain('provider exploded')
  })

  it('fails on a max-tokens finish when expansion is disabled', async () => {
    const state = makeCtx([textStream('', { type: 'finish', reason: { kind: 'max-tokens' } })])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxTokenRetryFactor: 1 })
    await expect(service.optimize('x')).rejects.toThrow(/maxTokens/)
  })

  it('expands maxTokens and retries once on a max-tokens finish', async () => {
    const state = makeCtx([
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream(FOUR_SECTIONS),
    ])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.retries).toBe(1)
    expect(state.streamCalls).toHaveLength(2)
    expect(state.streamCalls[0].maxTokens).toBe(1200)
    expect(state.streamCalls[1].maxTokens).toBe(1800)
  })

  it('bumps temperature on retry', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls[0].temperature).toBe(0.2)
    expect(state.streamCalls[1].temperature).toBe(0.5)
  })

  it('passes through an already-optimized input when skipIfAlreadyOptimized', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, skipIfAlreadyOptimized: true })
    const result = await service.optimize(FOUR_SECTIONS)
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
    expect(result.retries).toBe(0)
    expect(state.streamCalls).toHaveLength(0)
  })

  it('honors per-call temperature and maxTokens overrides', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x', { temperature: 0.9, maxTokens: 500 })
    expect(result.optimized).toBe(true)
    expect(state.streamCalls[0].temperature).toBe(0.9)
    expect(state.streamCalls[0].maxTokens).toBe(500)
  })

  it('honors an already-aborted caller signal', async () => {
    const state = makeCtx([])
    const service = makeService(state)
    const controller = new AbortController()
    controller.abort()
    await expect(service.optimize('x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.streamCalls).toHaveLength(0)
  })

  it('is stateless across concurrent calls', async () => {
    const state = makeCtx((options: GenerateOptions) =>
      textStream(options.system?.includes('AAA') ? FOUR_SECTIONS : THREE_SECTIONS),
    )
    const service = makeService(state)
    const [a, b] = await Promise.all([
      service.optimize('AAA'),
      service.optimize('BBB'),
    ])
    expect(a.optimized).toBe(true)
    expect(b.optimized).toBe(false)
  })
})
