import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import type { Config } from '../src/config.js'
import { OptimizeError, OptimizeErrorCode } from '../src/errors.js'
import { MaxTokensError, PROMPT_OPTIMIZER_TIMEOUT_CODE, PromptOptimizerService } from '../src/optimizer.js'
import { renderOptimizeResult } from '../src/tool.js'

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
  dreamInsightFeedback: false,
  classifier: 'heuristic',
  localTemplate: 'off',
}

/** Build a text-only chunk stream (delta-only, tolerated by BlockAssembler). */
function textStream(text: string, finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield finish
  })()
}

/** Stream each string as one text-delta chunk, then a stop finish. */
function chunkStream(...chunks: string[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const text of chunks) yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** Stream a prefix, then a long tail one character at a time (thin-delta tail). */
function tailStream(prefix: string, tail: string): AsyncIterable<StreamChunk> {
  return chunkStream(prefix, ...tail.split(''))
}

interface CtxStub {
  ctx: unknown
  streamCalls: GenerateOptions[]
  emitCalls: { name: string; payload: unknown }[]
  registerCalls: unknown[]
  sectionCalls: unknown[]
  commandCalls: unknown[]
  selection?: { provider: string; model: string; reasoningEffort?: string }
}

function makeCtx(
  streams: AsyncIterable<StreamChunk>[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>),
  options?: { throwingEmit?: boolean },
): CtxStub {
  const streamCalls: GenerateOptions[] = []
  const emitCalls: { name: string; payload: unknown }[] = []
  const registerCalls: unknown[] = []
  const sectionCalls: unknown[] = []
  const commandCalls: unknown[] = []
  const state: CtxStub = { ctx: undefined, streamCalls, emitCalls, registerCalls, sectionCalls, commandCalls }
  const ctx = {
    reflect: { provide: () => {} },
    get: (key: string) => (key === 'agentDefaultModel' ? { currentSelection: () => state.selection } : undefined),
    emit: (name: string, payload: unknown) => {
      if (options?.throwingEmit) throw new Error('listener boom')
      emitCalls.push({ name, payload })
    },
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

  it('uses the English role document when metaPromptLanguage is 英文', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, metaPromptLanguage: '英文' })
    const result = await service.optimize('帮我写一份 PRD', { signal: new AbortController().signal })
    expect(result.optimized).toBe(true)
    expect(state.streamCalls[0].system).toContain('You are a prompt optimization expert')
    expect(state.streamCalls[0].system).not.toContain('你是一名提示词优化专家')
  })

  it('injects per-call conversation context into the system prompt', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('帮我写一份 PRD', {
      signal: new AbortController().signal,
      context: '之前讨论过预算 5 万',
    })
    expect(result.optimized).toBe(true)
    const system = state.streamCalls[0].system
    expect(system).toContain('对话上下文（仅作背景参考）')
    expect(system).toContain('之前讨论过预算 5 万')
    expect(system).not.toContain('{{上下文信息}}')
  })

  it('omits the context block when no per-call context is given', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('帮我写一份 PRD', { signal: new AbortController().signal })
    expect(state.streamCalls[0].system).not.toContain('对话上下文（仅作背景参考）')
  })

  it('honours a runtime metaPromptLanguage override over the config', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state) // config default 中文
    service.setMetaPromptLanguage('en')
    await service.optimize('帮我写一份 PRD', { signal: new AbortController().signal })
    expect(state.streamCalls[0].system).toContain('You are a prompt optimization expert')
  })

  it('auto mode uses the Chinese role document for Chinese input', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, metaPromptLanguage: 'auto' })
    await service.optimize('帮我写一份 PRD', { signal: new AbortController().signal })
    expect(state.streamCalls[0].system).toContain('你是一名提示词优化专家')
    expect(state.streamCalls[0].system).not.toContain('You are a prompt optimization expert')
  })

  it('auto mode uses the English role document for English input', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, metaPromptLanguage: 'auto' })
    await service.optimize('Write a product requirements document', { signal: new AbortController().signal })
    expect(state.streamCalls[0].system).toContain('You are a prompt optimization expert')
    expect(state.streamCalls[0].system).not.toContain('你是一名提示词优化专家')
  })

  it('auto mode iterate detects the language from the new instruction', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, metaPromptLanguage: 'auto' })
    await service.iterate(FOUR_SECTIONS, '帮我改成面向中小企业的版本', { signal: new AbortController().signal })
    expect(state.streamCalls[0].system).toContain('你是一名提示词优化专家')
  })

  it('clearing the runtime override falls back to the auto config', async () => {
    const service = makeService(makeCtx([textStream(FOUR_SECTIONS)]), { ...DEFAULT_CONFIG, metaPromptLanguage: 'auto' })
    expect(service.getMetaPromptLanguage()).toBe('auto')
    service.setMetaPromptLanguage('en')
    expect(service.getMetaPromptLanguage()).toBe('en')
    service.setMetaPromptLanguage('auto')
    expect(service.getMetaPromptLanguage()).toBe('auto')
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
    // 1.5.3（C-3）：retries 返回实际校验失败次数（2 次调用均失败）。
    expect(result.retries).toBe(2)
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

  it('accepts plain-style output when outputStyle is plain', async () => {
    const PLAIN = '你是产品经理。把需求整理为 PRD，面向中小企业，预算有限，输出 Markdown 文档，不超过 500 字。'
    const state = makeCtx([textStream(PLAIN)])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain' })
    const result = await service.optimize('帮我写一份 PRD')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(PLAIN)
    expect(result.sections).toBeUndefined()
    const system = state.streamCalls[0].system ?? ''
    expect(system).toContain('严禁使用任何小节标题')
    expect(system).not.toContain('## Role')
  })

  it('retries a too-short plain output, then falls back', async () => {
    const state = makeCtx([textStream('太短'), textStream('太短')])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10 })
    const result = await service.optimize('原始指令原文')
    expect(result.optimized).toBe(false)
    expect(result.prompt).toBe('原始指令原文')
    expect(result.error).toMatch(/fewer than 10/)
    // 1.5.3（C-3）：retries 返回实际校验失败次数。
    expect(result.retries).toBe(2)
    expect(state.streamCalls).toHaveLength(2)
  })

  it('does not skip plain-mode inputs even with skipIfAlreadyOptimized', async () => {
    const state = makeCtx([textStream('plain 输出正文足够长')])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', skipIfAlreadyOptimized: true })
    const result = await service.optimize('一段普通文本')
    expect(state.streamCalls).toHaveLength(1)
    expect(result.optimized).toBe(true)
  })

  it('reports the output token estimate on success', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('帮我写一份 PRD')
    expect(result.outputTokens).toBeGreaterThan(0)
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
    const error = await service.optimize('x').then(() => null, (e: Error & { detailCode?: string }) => e)
    expect(error).toBeInstanceOf(Error)
    // 1.5.3（C-2）：OptimizeError 归 UNKNOWN，harness 原始码经 detailCode 保留。
    expect((error as Error & { detailCode?: string }).detailCode).toBe('RATE_LIMIT')
    expect((error as Error).message).toContain('provider exploded')
  })

  it('fails on a max-tokens finish when expansion is disabled', async () => {
    const state = makeCtx([textStream('', { type: 'finish', reason: { kind: 'max-tokens' } })])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxTokenRetryFactor: 1 })
    await expect(service.optimize('x')).rejects.toThrow(/maxTokens/)
  })

  it('expands maxTokens and retries without consuming the retry budget', async () => {
    const state = makeCtx([
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream(FOUR_SECTIONS),
    ])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.retries).toBe(0)
    expect(state.streamCalls).toHaveLength(2)
    expect(state.streamCalls[0].maxTokens).toBe(1200)
    expect(state.streamCalls[1].maxTokens).toBe(2400)
  })

  it('expands repeatedly up to maxTokensCap (jump factor 2)', async () => {
    const state = makeCtx([
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream(FOUR_SECTIONS),
    ])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.retries).toBe(0)
    expect(state.streamCalls.map((c) => c.maxTokens)).toEqual([1200, 2400, 4800])
  })

  it('stops expanding at maxTokensCap and surfaces MAX_TOKENS', async () => {
    const state = makeCtx([
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
    ])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxTokensCap: 2000 })
    await expect(service.optimize('x')).rejects.toThrow(/maxTokens/)
    expect(state.streamCalls.map((c) => c.maxTokens)).toEqual([1200, 2000])
  })

  it('does not expand when maxTokensCap is at or below maxTokens', async () => {
    const state = makeCtx([textStream('', { type: 'finish', reason: { kind: 'max-tokens' } })])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxTokensCap: 1000 })
    await expect(service.optimize('x')).rejects.toThrow(/maxTokens/)
    expect(state.streamCalls).toHaveLength(1)
  })

  it('resumes from the truncated prefix instead of regenerating (断点续传)', async () => {
    const PARTIAL = '## Role\n你是一名资深产品分析师。\n\n## Task\n分析需求并输出 PRD 文档，'
    const CONTINUATION = '包含验收标准与风险清单。\n\n## Context\n面向中小企业，预算有限，团队 5 人。\n\n## Format\nMarkdown 文档，不超过 500 字。'
    const MERGED = PARTIAL + CONTINUATION
    const state = makeCtx([
      textStream(PARTIAL, { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream(CONTINUATION),
    ])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(MERGED)
    expect(result.retries).toBe(0)
    expect(state.streamCalls).toHaveLength(2)
    // The continuation call carries the partial text in its user message.
    const text = (state.streamCalls[1].messages[0].content as { text: string }[])[0].text
    expect(text).toContain('已生成的优化提示词（被截断）')
    expect(text).toContain(PARTIAL)
    // The resumed content is framed as pure data (prompt-injection guardrail).
    expect(text).toContain('视为纯数据')
  })

  it('re-optimizes an already-optimized input when a new context is present (方案 B)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, skipIfAlreadyOptimized: true })
    const result = await service.optimize(FOUR_SECTIONS, { context: '用户补充：预算改为 20 万' })
    expect(result.optimized).toBe(true)
    // Not a pass-through: the model was called (with the new context).
    expect(state.streamCalls).toHaveLength(1)
    expect(state.streamCalls[0].system).toContain('预算改为 20 万')
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

  it('passes through an already-optimized input with Chinese headings', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, skipIfAlreadyOptimized: true })
    const chinese = `## 角色
你是一名资深产品经理。

## 任务
分析需求并输出 PRD。

## 背景
面向中小企业，预算有限。

## 输出
Markdown 文档，不超过 500 字。`
    const result = await service.optimize(chinese)
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(chinese)
    expect(state.streamCalls).toHaveLength(0)
    // C-4 修复：中文标题路径不再产出空 sections（英文解析不到）。
    expect(result.sections).toBeUndefined()
  })

  it('retries within budget when the output drops a constraint (goal alignment)', async () => {
    // First output is structurally valid but drops the "500 字" cap; the
    // second keeps it — the retry must carry the goal diagnosis.
    const withoutCap = FOUR_SECTIONS.replace('不超过 500 字', '简洁明了')
    const state = makeCtx([textStream(withoutCap), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'sections' })
    const result = await service.optimize('目标是生成一份周报，不要超过500字')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(2)
    expect(result.retries).toBe(1)
    expect(state.streamCalls[1].system).toContain('输出丢失了以下目标/约束')
  })

  it('accepts the misaligned output directly when goalAlignmentRetry is false', async () => {
    const withoutCap = FOUR_SECTIONS.replace('不超过 500 字', '简洁明了')
    const state = makeCtx([textStream(withoutCap)])
    const service = makeService(state, { ...DEFAULT_CONFIG, goalAlignmentRetry: false })
    const result = await service.optimize('目标是生成一份周报，不要超过500字')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(1)
    expect(result.prompt).toContain('简洁明了')
  })

  it('fast profile skips validation retries (one attempt only)', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, optimizationProfile: 'fast' })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(state.streamCalls).toHaveLength(1)
  })

  it('fast profile skips goal-alignment retries', async () => {
    const withoutCap = FOUR_SECTIONS.replace('不超过 500 字', '简洁明了')
    const state = makeCtx([textStream(withoutCap)])
    const service = makeService(state, { ...DEFAULT_CONFIG, optimizationProfile: 'fast' })
    const result = await service.optimize('目标是生成一份周报，不要超过500字')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(1)
  })

  it('early-stops the stream once the output is valid and the tail is thin', async () => {
    // 加固（1.4.5）：早停只在句子边界（句号等）允许——凑字尾流以标点收尾
    // 才能被截断；无标点的纯重复会完整消费（防半句截断）。
    const state = makeCtx([tailStream(FOUR_SECTIONS, '尾。'.repeat(40))])
    const service = makeService(state, { ...DEFAULT_CONFIG })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(1)
    expect(result.prompt).toContain('## Format')
    // The trailing filler was cut off well before the full tail.
    expect(result.prompt).not.toContain('尾'.repeat(20))
  })

  it('keeps consuming while the output still grows (no premature stop)', async () => {
    const filler = '尾'.repeat(200)
    const state = makeCtx([chunkStream(FOUR_SECTIONS, filler)])
    const service = makeService(state, { ...DEFAULT_CONFIG })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toContain(filler)
  })

  it('consumes the full stream when earlyStop is disabled', async () => {
    const state = makeCtx([tailStream(FOUR_SECTIONS, '尾'.repeat(80))])
    const service = makeService(state, { ...DEFAULT_CONFIG, earlyStop: false })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toContain('尾'.repeat(80))
  })

  it('does not early-stop mid-sentence (1.4.5 guardrail, sentence boundary only)', async () => {
    // 用户报告场景：结构先出现、正文以无标点短句逐字输出（中文流增量小）——
    // 不得被早停截断在句中间（"…有逻辑、有"半句）。无标点 → 完整消费。
    const state = makeCtx([tailStream(FOUR_SECTIONS, '尾'.repeat(80))])
    const service = makeService(state, { ...DEFAULT_CONFIG })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toContain('尾'.repeat(80))
  })

  it('skips built-in examples when builtinExamples is false (1.4.6)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, builtinExamples: false })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls[0].system).not.toContain('示例 1')
  })

  it('reports the prompt-side input tokens of the last call (1.4.6)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG })
    await service.optimize('x')
    expect(service.getStats().lastInputTokens).toBeGreaterThan(0)
  })

  it('injects the goal-drift line into an iterate system prompt', async () => {    // The previous prompt carries a constraint the new instruction drops,
    // so the iterate system must tell the model what changed. The first
    // output misses the new goal anchor (周报), triggering a retry whose
    // second output carries it.
    const last = '## Task\n写周报\n\n## Context\n必须不超过300字'
    const reportSections = '## Role\n你是一名资深数据分析师。\n\n## Task\n撰写一份面向团队的周报。\n\n## Context\n团队五人，正在推进新版本。\n\n## Format\n300 字以内，Markdown。'
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(reportSections)])
    const service = makeService(state)
    const result = await service.iterate(last, '目标是生成一份周报')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(2)
    expect(state.streamCalls[0].system).toContain('相对上次结果')
    expect(state.streamCalls[0].system).toContain('目标：目标是生成一份周报')
  })

  it('carries a registered session goal into a later call (sessionId registry)', async () => {
    const report = '## Role\n你是一名资深数据分析师。\n\n## Task\n撰写一份面向团队的周报。\n\n## Context\n团队五人，正在推进新版本。\n\n## Format\n500 字以内，Markdown。'
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(report), textStream(report)])
    const service = makeService(state)
    await service.optimize('目标是生成一份周报，不要超过500字', { sessionId: 's1' })
    const second = await service.optimize('输出全文', { sessionId: 's1' })
    expect(second.optimized).toBe(true)
    // The second call restates no goal, yet the registered goal/constraint
    // from the first call is injected into the situation block.
    expect(state.streamCalls[2].system).toContain('目标：目标是生成一份周报')
    expect(state.streamCalls[2].system).toContain('约束：不要超过500字')
  })

  it('does not share goals across sessions', async () => {
    const report = '## Role\n你是一名资深数据分析师。\n\n## Task\n撰写一份面向团队的周报。\n\n## Context\n团队五人，正在推进新版本。\n\n## Format\n500 字以内，Markdown。'
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(report), textStream(report)])
    const service = makeService(state)
    await service.optimize('目标是生成一份周报，不要超过500字', { sessionId: 's1' })
    const other = await service.optimize('输出全文', { sessionId: 's2' })
    expect(other.optimized).toBe(true)
    expect(state.streamCalls[2].system).not.toContain('目标：目标是生成一份周报')
  })

  it('includes the situation profile in the start event', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('目标是生成一份周报')
    const start = state.emitCalls.find((e) => e.name === 'prompt-optimizer/optimize:start')
    expect(start).toBeDefined()
    const payload = start?.payload as { profile?: { version?: number; goal?: { primary?: string } } }
    expect(payload.profile?.version).toBe(2)
    expect(payload.profile?.goal?.primary).toContain('周报')
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

  it('leaves errorCode undefined on success', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.errorCode).toBeUndefined()
  })

  it('tags a missing-sections fallback with MISSING_SECTIONS', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(THREE_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(result.errorCode).toBe('MISSING_SECTIONS')
  })

  it('tags a thin-section fallback with THIN_SECTIONS', async () => {
    const THIN = '## Role\n\n## Task\n\n## Context\n\n## Format\n'
    const state = makeCtx([textStream(THIN), textStream(THIN)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(result.errorCode).toBe('THIN_SECTIONS')
  })

  it('tags a thin plain-output fallback with THIN_OUTPUT', async () => {
    const state = makeCtx([textStream('太短'), textStream('太短')])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10 })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(result.errorCode).toBe('THIN_OUTPUT')
  })

  it('throws OptimizeError(NO_MODEL_ROUTE) when no route exists', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, provider: undefined, model: undefined })
    const error = await service.optimize('x').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('NO_MODEL_ROUTE')
  })

  it('throws OptimizeError(EMPTY_INPUT) for an empty instruction', async () => {
    const state = makeCtx([])
    const service = makeService(state)
    const error = await service.optimize('   ').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('EMPTY_INPUT')
  })

  it('classifies MaxTokensError as OptimizeError MAX_TOKENS', async () => {
    const state = makeCtx([textStream('', { type: 'finish', reason: { kind: 'max-tokens' } })])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxTokenRetryFactor: 1 })
    const error = await service.optimize('x').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(MaxTokensError)
    expect((error as OptimizeError).code).toBe('MAX_TOKENS')
  })

  it('classifies a tool-call finish as TOOL_CALL', async () => {
    const state = makeCtx([textStream('', { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk)])
    const service = makeService(state)
    const error = await service.optimize('x').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('TOOL_CALL')
  })

  it('classifies an empty model output as NO_TEXT', async () => {
    const state = makeCtx([textStream('')])
    const service = makeService(state)
    const error = await service.optimize('x').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('NO_TEXT')
  })

  it('wraps a deadline timeout as OptimizeError TIMEOUT', async () => {
    const stream = (): AsyncIterable<StreamChunk> => (async function* () {
      const reason = new TimeoutReason(PROMPT_OPTIMIZER_TIMEOUT_CODE, 10)
      yield { type: 'text-delta', index: 0, text: '' } as StreamChunk
      throw Object.assign(new Error('aborted'), { reason })
    })()
    const state = makeCtx(stream)
    const service = makeService(state)
    const error = await service.optimize('x').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('TIMEOUT')
    expect((error as OptimizeError).message).toMatch(/timed out after 10ms/)
  })

  it('renders the error code into the tool failure text', () => {
    const blocks = renderOptimizeResult({
      prompt: '原文',
      optimized: false,
      error: 'missing sections',
      errorCode: 'MISSING_SECTIONS',
      retries: 1,
    })
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('[MISSING_SECTIONS]')
    expect(text).toContain('ORIGINAL')
  })

  it('renders UNKNOWN when the error code is absent', () => {
    const blocks = renderOptimizeResult({ prompt: '原文', optimized: false, retries: 1 })
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('[UNKNOWN]')
  })

  it('injects missing-sections diagnosis into the retry system prompt', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.retries).toBe(1)
    const first = state.streamCalls[0].system ?? ''
    const retry = state.streamCalls[1].system ?? ''
    expect(first).not.toContain('上次输出存在以下问题')
    expect(retry).toContain('上次输出存在以下问题，本次输出必须修正')
    expect(retry).toContain('缺少以下段落：## Format')
  })

  it('injects thin-section diagnosis into the retry system prompt', async () => {
    const THIN = '## Role\n\n## Task\n\n## Context\n\n## Format\n'
    const state = makeCtx([textStream(THIN), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    const retry = state.streamCalls[1].system ?? ''
    expect(retry).toContain('内容过少')
    expect(retry).toContain('## Role')
  })

  it('uses English diagnosis text when the role document is English', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, metaPromptLanguage: '英文' })
    await service.optimize('x')
    const retry = state.streamCalls[1].system ?? ''
    expect(retry).toContain('The previous output had the following problems')
    expect(retry).toContain('Missing section: ## Format')
  })

  it('injects the plain-mode too-short diagnosis into the retry', async () => {
    const PLAIN = '你是产品经理。把需求整理为 PRD，面向中小企业，预算有限，输出 Markdown 文档，不超过 500 字。'
    const state = makeCtx([textStream('太短'), textStream(PLAIN)])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10 })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    const retry = state.streamCalls[1].system ?? ''
    expect(retry).toContain('输出过短（少于 10 有效字符）')
  })

  it('falls back with HEADINGS_IN_PLAIN when a plain output still carries headings', async () => {
    const WITH_HEADINGS = '## Role\n你是一名资深产品经理。\n\n## Task\n分析需求并输出 PRD。'
    const state = makeCtx([textStream(WITH_HEADINGS), textStream(WITH_HEADINGS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10 })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(result.errorCode).toBe('HEADINGS_IN_PLAIN')
  })

  it('injects the plain-mode headings diagnosis into the retry', async () => {
    const WITH_HEADINGS = '## Role\n你是一名资深产品经理。\n\n## Task\n分析需求并输出 PRD。'
    const PLAIN = '你是产品经理。把需求整理为 PRD，面向中小企业，预算有限，输出 Markdown 文档，不超过 500 字。'
    const state = makeCtx([textStream(WITH_HEADINGS), textStream(PLAIN)])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10 })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    const retry = state.streamCalls[1].system ?? ''
    expect(retry).toContain('不得包含任何小节标题')
  })

  it('injects the diagnosis into an iterate retry as well', async () => {
    const LAST = '## Role\n分析师\n\n## Task\n写周报\n\n## Context\n团队 5 人\n\n## Format\n300 字'
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.iterate(LAST, '改成英文')
    expect(result.optimized).toBe(true)
    const retry = state.streamCalls[1].system ?? ''
    expect(retry).toContain('缺少以下段落：## Format')
  })

  it('runs one refinement round and adopts the terser result when selfRefine is enabled', async () => {
    const VERBOSE = '## Role\n你是一名非常资深的、经验丰富的产品经理专家，拥有多年的行业经验。\n\n## Task\n认真分析需求并输出一份详细完整的 PRD 文档。\n\n## Context\n面向中小企业客户群体，预算有限，需要严格控制成本。\n\n## Format\n使用 Markdown 文档格式输出，全文不超过 500 字。'
    const TERSER = '## Role\n资深产品经理，多年行业经验。\n\n## Task\n分析需求，输出完整 PRD。\n\n## Context\n面向中小企业，预算有限。\n\n## Format\nMarkdown 文档，500 字以内。'
    const state = makeCtx([textStream(VERBOSE), textStream(TERSER)])
    const service = makeService(state, { ...DEFAULT_CONFIG, selfRefine: true })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(2)
    expect(state.streamCalls[1].system ?? '').toContain('进一步精简')
    expect(result.prompt).toBe(TERSER)
  })

  it('keeps the original when the refinement output fails validation', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(THREE_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, selfRefine: true })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
    expect(state.streamCalls).toHaveLength(2)
  })

  it('keeps the original when the refinement output is longer', async () => {
    const LONGER = '## Role\n你是一名非常资深的、经验丰富的产品经理专家，拥有多年的行业经验。\n\n## Task\n认真分析需求并输出一份详细完整的 PRD 文档。\n\n## Context\n面向中小企业客户群体，预算有限，需要严格控制成本。\n\n## Format\n使用 Markdown 文档格式输出，全文不超过 500 字。'
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(LONGER)])
    const service = makeService(state, { ...DEFAULT_CONFIG, selfRefine: true })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
  })

  it('keeps the original when the refinement call fails', async () => {
    const failing = (): AsyncIterable<StreamChunk> => (async function* () {
      yield { type: 'text-delta', index: 0, text: '' }
      throw new Error('refine boom')
    })()
    const state = makeCtx([textStream(FOUR_SECTIONS), failing()])
    const service = makeService(state, { ...DEFAULT_CONFIG, selfRefine: true })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
  })

  it('skips the refinement round by default', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(1)
  })

  it('refines a plain-style result too', async () => {
    const PLAIN = '你是产品经理。把需求整理为 PRD，面向中小企业，预算有限，输出 Markdown 文档，不超过 500 字。'
    const TERSER = '你是产品经理。整理需求为 PRD，面向中小企业，预算有限，输出 Markdown，500 字内。'
    const state = makeCtx([textStream(PLAIN), textStream(TERSER)])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10, selfRefine: true })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(state.streamCalls[1].system ?? '').toContain('进一步精简')
    expect(result.prompt).toBe(TERSER)
  })
})

describe('PromptOptimizerService.iterate', () => {
  const LAST = '## Role\n分析师\n\n## Task\n写周报\n\n## Context\n团队 5 人\n\n## Format\n300 字'

  it('iterates on the previous result with the new requirement', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.iterate(LAST, '改成英文', { signal: new AbortController().signal })
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
    expect(result.retries).toBe(0)
    // The iteration context reaches the model as the system prompt.
    const system = state.streamCalls[0].system
    expect(system).toContain('上一次优化得到的提示词')
    expect(system).toContain(LAST)
    expect(system).toContain('改成英文')
  })

  it('keeps the previous result when the iteration falls back', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(THREE_SECTIONS)])
    const service = makeService(state)
    const result = await service.iterate(LAST, '改成英文')
    expect(result.optimized).toBe(false)
    expect(result.prompt).toBe(LAST)
    expect(result.errorCode).toBe('MISSING_SECTIONS')
    expect(result.error).toBeDefined()
  })

  it('rejects an empty previous result', async () => {
    const state = makeCtx([])
    const service = makeService(state)
    const error = await service.iterate('   ', '改成英文').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('EMPTY_INPUT')
  })

  it('rejects an empty iteration instruction', async () => {
    const state = makeCtx([])
    const service = makeService(state)
    const error = await service.iterate(LAST, '   ').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OptimizeError)
    expect((error as OptimizeError).code).toBe('EMPTY_INPUT')
  })

  it('falls back to the previous result in plain mode', async () => {
    const state = makeCtx([textStream('太短'), textStream('太短')])
    const service = makeService(state, { ...DEFAULT_CONFIG, outputStyle: 'plain', minSectionChars: 10 })
    const result = await service.iterate(LAST, '精简')
    expect(result.optimized).toBe(false)
    expect(result.prompt).toBe(LAST)
    expect(result.errorCode).toBe('THIN_OUTPUT')
  })
})

describe('PromptOptimizerService events', () => {
  const LAST = '## Role\n分析师\n\n## Task\n写周报\n\n## Context\n团队 5 人\n\n## Format\n300 字'

  it('emits start and success with the optimize method on success', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('帮我写一份 PRD')
    expect(result.optimized).toBe(true)
    expect(state.emitCalls.map((c) => c.name)).toEqual([
      'prompt-optimizer/optimize:start',
      'prompt-optimizer/optimize:success',
    ])
    const start = state.emitCalls[0].payload as { method: string; input: string }
    expect(start.method).toBe('optimize')
    expect(start.input).toBe('帮我写一份 PRD')
    const done = state.emitCalls[1].payload as { method: string; result: { optimized: boolean }; durationMs: number }
    expect(done.method).toBe('optimize')
    expect(done.result.optimized).toBe(true)
    expect(done.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits a failure event with the error code when the run falls back', async () => {
    const state = makeCtx([textStream(THREE_SECTIONS), textStream(THREE_SECTIONS)])
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(state.emitCalls.map((c) => c.name)).toEqual([
      'prompt-optimizer/optimize:start',
      'prompt-optimizer/optimize:failure',
    ])
    const done = state.emitCalls[1].payload as { result: { errorCode?: string } }
    expect(done.result.errorCode).toBe('MISSING_SECTIONS')
  })

  it('tags iterate runs with the iterate method', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.iterate(LAST, '改成英文')
    expect(state.emitCalls.map((c) => c.name)).toEqual([
      'prompt-optimizer/optimize:start',
      'prompt-optimizer/optimize:success',
    ])
    const start = state.emitCalls[0].payload as { method: string }
    expect(start.method).toBe('iterate')
  })

  it('swallows a throwing listener and still returns the result', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)], { throwingEmit: true })
    const service = makeService(state)
    const result = await service.optimize('x')
    expect(result.optimized).toBe(true)
    expect(result.prompt).toBe(FOUR_SECTIONS)
  })

  it('does not emit events for a skipped passthrough', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, skipIfAlreadyOptimized: true })
    const result = await service.optimize(FOUR_SECTIONS)
    expect(result.optimized).toBe(true)
    expect(state.emitCalls).toHaveLength(0)
    expect(state.streamCalls).toHaveLength(0)
  })

  it('does not emit events for an invalid input', async () => {
    const state = makeCtx([])
    const service = makeService(state)
    await service.optimize('  ').then(() => null, () => null)
    expect(state.emitCalls).toHaveLength(0)
  })
})

describe('PromptOptimizerService cache (ADR-008)', () => {
  const LAST = '## Role\n分析师\n\n## Task\n写周报\n\n## Context\n团队 5 人\n\n## Format\n300 字'

  it('returns the cached result on a repeat call without calling the model', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const first = await service.optimize('帮我写周报', { signal: new AbortController().signal })
    expect(first.optimized).toBe(true)
    const second = await service.optimize('帮我写周报', { signal: new AbortController().signal })
    expect(second.optimized).toBe(true)
    expect(second.prompt).toBe(first.prompt)
    // Only the first call reached the model.
    expect(state.streamCalls).toHaveLength(1)
  })

  it('misses the cache when the context differs', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('x', { context: '第一轮' })
    await service.optimize('x', { context: '第二轮' })
    expect(state.streamCalls).toHaveLength(2)
  })

  it('misses the cache when the instruction differs', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('写周报')
    await service.optimize('写月报')
    expect(state.streamCalls).toHaveLength(2)
  })

  it('does not cache failed (unoptimized) results', async () => {
    const state = makeCtx([textStream('缺段'), textStream('缺段')])
    const service = makeService(state)
    await service.optimize('x').then(() => null, () => null)
    await service.optimize('x').then(() => null, () => null)
    // Both runs went to the model: the failure was not cached.
    expect(state.streamCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('bypasses the cache entirely when cacheEnabled is false', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, cacheEnabled: false })
    await service.optimize('x')
    await service.optimize('x')
    expect(state.streamCalls).toHaveLength(2)
  })

  it('caches iterate results too', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.iterate(LAST, '改成英文')
    const second = await service.iterate(LAST, '改成英文')
    expect(second.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(1)
  })

  it('warm-starts from the cached result when only the context changes (阶段 1A)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    const first = await service.optimize('写周报', { context: '第一轮：预算 5 万' })
    expect(first.optimized).toBe(true)
    // Same instruction, new context: exact miss → near-miss warm start runs an
    // iterate refinement (one call) instead of a full re-optimization.
    const second = await service.optimize('写周报', { context: '第二轮：预算改为 20 万' })
    expect(second.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(2)
    const system = state.streamCalls[1].system ?? ''
    expect(system).toContain('第二轮：预算改为 20 万')
  })

  it('warm-starts for a similar instruction (阶段 1A)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, cacheFuzzyThreshold: 0.4 })
    await service.optimize('帮我写一份周报')
    const second = await service.optimize('帮我写一份月报')
    expect(second.optimized).toBe(true)
    // Exact miss + fuzzy match → one iterate call (framed around the previous
    // result) instead of a full re-optimization.
    expect(state.streamCalls).toHaveLength(2)
    expect(state.streamCalls[1].system ?? '').toContain('上次')
  })

  it('enrich bypasses the exact cache hit (阶段 1B)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS), textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('x')
    const second = await service.optimize('x', { enrich: true })
    expect(second.optimized).toBe(true)
    expect(state.streamCalls).toHaveLength(2)
  })

  it('appends the 延伸洞察 appendix block when senseNeeds is on (阶段 2A)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('写周报', { senseNeeds: true })
    expect(state.streamCalls[0].system).toContain('延伸洞察（AI 推断')
    // Without senseNeeds the appendix block is absent.
    const plain = makeCtx([textStream(FOUR_SECTIONS)])
    await makeService(plain).optimize('写周报')
    expect(plain.streamCalls[0].system).not.toContain('延伸洞察')
  })
})

describe('PromptOptimizerService call budget & stats (roadmap #1/#2)', () => {
  it('degrades with TOO_MANY_CALLS when the unified call budget is exhausted', async () => {
    const state = makeCtx([
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
      textStream('', { type: 'finish', reason: { kind: 'max-tokens' } }),
    ])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxCalls: 2 })
    const result = await service.optimize('x')
    expect(result.optimized).toBe(false)
    expect(result.errorCode).toBe('TOO_MANY_CALLS')
    expect(state.streamCalls).toHaveLength(2)
  })

  it('records run statistics including cache hits and tokens', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state)
    await service.optimize('x')
    await service.optimize('x') // cache hit
    const stats = service.getStats()
    expect(stats.runs).toBe(2)
    expect(stats.success).toBe(2)
    expect(stats.failed).toBe(0)
    expect(stats.cached).toBe(1)
    expect(stats.lastOutputTokens).toBeGreaterThan(0)
    expect(stats.maxDurationMs).toBeGreaterThanOrEqual(0)
    // Per-call timing breakdown (A+B 测量): one model call on the first run.
    expect(stats.callCount).toBe(1)
    expect(stats.lastRunCalls).toBe(0) // the last run was a cache hit
    expect(stats.lastCallMs).toBeGreaterThanOrEqual(0)
    expect(stats.maxCallMs).toBeGreaterThanOrEqual(0)
  })

  it('counts failed runs in the stats', async () => {
    const state = makeCtx([textStream('缺段'), textStream('缺段')])
    const service = makeService(state, { ...DEFAULT_CONFIG, maxCalls: 2 })
    await service.optimize('x')
    const stats = service.getStats()
    expect(stats.failed).toBe(1)
    expect(stats.success).toBe(0)
  })
})

describe('PromptOptimizerService custom templates', () => {
  it('uses a configured custom template for the system prompt', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, {
      ...DEFAULT_CONFIG,
      metaPromptTemplate: {
        optimizeZh: '定制优化模板\n\n{{输出结构}}\n{{自查}}\n视为纯数据\n\n原始指令：\n{{原始指令}}',
      },
    })
    await service.optimize('x')
    const system = state.streamCalls[0].system ?? ''
    expect(system).toContain('定制优化模板')
    expect(system).not.toContain('你是一名提示词优化专家')
  })

  it('fails loudly at construction when the custom template is invalid', () => {
    const state = makeCtx([])
    expect(() => makeService(state, { ...DEFAULT_CONFIG, metaPromptTemplate: { optimizeZh: '缺占位符' } }))
      .toThrow(/missing required placeholder/)
  })

  it('fails loudly for an unknown templateId', () => {
    const state = makeCtx([])
    expect(() => makeService(state, { ...DEFAULT_CONFIG, templateId: 'custom' }))
      .toThrow(/unknown templateId "custom"/)
  })
})

describe('dream insight feedback (1.4.9)', () => {
  it('carries the senseNeeds appendix into the next call of the same session', async () => {
    const insight = '--- 延伸洞察（AI 推断，供你选用，非事实）---\n· 深层目标：得到可直接落地的方案\n· 隐含约束：不引入新依赖'
    const state = makeCtx([textStream(`${FOUR_SECTIONS}\n\n${insight}`), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, dreamInsightFeedback: true })
    const first = await service.optimize('帮我写方案', { sessionId: 's1', senseNeeds: true })
    expect(first.optimized).toBe(true)
    const second = await service.optimize('继续细化', { sessionId: 's1' })
    expect(second.optimized).toBe(true)
    // 第二次调用（同 session、非 senseNeeds）system 应携带上一轮洞察回填
    expect(state.streamCalls[1].system).toContain('延伸洞察')
  })

  it('does not inject dream insights when feedback is off', async () => {
    const insight = '--- 延伸洞察（AI 推断，供你选用，非事实）---\n· 深层目标：目标'
    const state = makeCtx([textStream(`${FOUR_SECTIONS}\n\n${insight}`), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, dreamInsightFeedback: false })
    await service.optimize('帮我写方案', { sessionId: 's1', senseNeeds: true })
    await service.optimize('继续细化', { sessionId: 's1' })
    expect(state.streamCalls[1].system).not.toContain('延伸洞察')
  })

  it('does not serve a stale cache hit once dream insights exist (C-1 fix)', async () => {
    const insight = '--- 延伸洞察（AI 推断，供你选用，非事实）---\n· 深层目标：得到可直接落地的方案'
    const state = makeCtx([textStream(`${FOUR_SECTIONS}\n\n${insight}`), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, dreamInsightFeedback: true })
    await service.optimize('帮我写方案', { sessionId: 's1', senseNeeds: true })
    const second = await service.optimize('帮我写方案', { sessionId: 's1' })
    expect(second.optimized).toBe(true)
    // 修复前：第二次命中不含洞察的旧缓存（仅 1 次流调用）；修复后：缓存键含
    // dream 回填 → 不命中 → 重新生成（2 次流调用），且第二次 system 携带洞察。
    expect(state.streamCalls).toHaveLength(2)
    expect(state.streamCalls[1].system).toContain('上一轮 AI 推断洞察')
  })

  it('uses the English dream block and extracts the en marker (M-1 fix)', async () => {
    const insight = '--- Extended insights (AI-inferred, optional, NOT facts) ---\n· Deep goal: X'
    const state = makeCtx([textStream(`${FOUR_SECTIONS}\n\n${insight}`), textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, dreamInsightFeedback: true, metaPromptLanguage: '英文' })
    await service.optimize('write a plan', { sessionId: 's1', senseNeeds: true })
    expect(state.streamCalls[0].system).toContain('Needs sensing (dream mode)')
    const second = await service.optimize('write a plan', { sessionId: 's1' })
    expect(second.optimized).toBe(true)
    expect(state.streamCalls[1].system).toContain('Previous AI-inferred insights')
    expect(state.streamCalls[1].system).toContain('Deep goal: X')
  })
})

describe('localTemplate zero-token path (1.5.6)', () => {
  it('renders locally (no llm call) when the gate passes in auto mode', async () => {
    // 「写一份周报…」→ writing-report + 有可抽取信号 → 本地直出。
    const state = makeCtx([]) // no streams: a model call would fail the test
    const service = makeService(state, { ...DEFAULT_CONFIG, localTemplate: 'auto' })
    const result = await service.optimize('写一份周报，总结本周进展和下周计划', { signal: new AbortController().signal })
    expect(result.optimized).toBe(true)
    expect(result.local).toBe(true)
    expect(result.prompt).toContain('## Role')
    expect(result.prompt).toContain('## Task')
    expect(result.prompt).toContain('## Context')
    expect(result.prompt).toContain('## Format')
    expect(state.streamCalls).toHaveLength(0) // zero model calls
  })

  it('falls back to the LLM pipeline when the gate rejects (auto)', async () => {
    // 无子类命中的指令 → 门控拒绝 → 走 LLM。
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, localTemplate: 'auto' })
    const result = await service.optimize('帮我写一份 PRD', { signal: new AbortController().signal })
    expect(result.optimized).toBe(true)
    expect(result.local).toBeUndefined()
    expect(state.streamCalls).toHaveLength(1)
  })

  it('respects localTemplate: off (never local)', async () => {
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, localTemplate: 'off' })
    const result = await service.optimize('写一份周报，总结本周进展和下周计划', { signal: new AbortController().signal })
    expect(result.local).toBeUndefined()
    expect(state.streamCalls).toHaveLength(1)
  })

  it('on mode renders local whenever a subcategory matches (no signal needed)', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, localTemplate: 'on' })
    // 仅子类命中、无显式信号 —— 'on' 也直出（auto 会因 no-signal 回落）。
    const result = await service.optimize('帮我写周报', { signal: new AbortController().signal })
    expect(result.optimized).toBe(true)
    expect(result.local).toBe(true)
    expect(state.streamCalls).toHaveLength(0)
  })

  it('counts local renders in stats and /optimize-stats LOCAL token', async () => {
    const state = makeCtx([])
    const service = makeService(state, { ...DEFAULT_CONFIG, localTemplate: 'auto' })
    await service.optimize('写一份周报，总结本周进展和下周计划', { signal: new AbortController().signal })
    expect(service.getStats().local).toBe(1)
  })
})

describe('localTemplate per-call override (1.5.6 方案 C)', () => {
  it('forces the LLM pipeline for a single call even when config is auto (refine path)', async () => {
    // 本地直出结果不满意 → 对同一指令以 localTemplate: 'off' 再调用 → 走 LLM 精修。
    const state = makeCtx([textStream(FOUR_SECTIONS)])
    const service = makeService(state, { ...DEFAULT_CONFIG, localTemplate: 'auto' })
    const result = await service.optimize('写一份周报，总结本周进展和下周计划', {
      signal: new AbortController().signal,
      localTemplate: 'off',
    })
    expect(result.optimized).toBe(true)
    expect(result.local).toBeUndefined()
    expect(state.streamCalls).toHaveLength(1) // exactly one model call
  })
})
