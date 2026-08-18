import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from '../src/config.js'
import {
  AUTO_OPTIMIZE_NOTE,
  isTriggered,
  messageText,
  optimizedMessage,
  registerAutoOptimizeHook,
} from '../src/hook.js'
import type { OptimizeOptions, PromptOptimizerService } from '../src/optimizer.js'

const BASE_CONFIG: Config = {
  temperature: 0.2,
  maxTokens: 1200,
  maxRetries: 1,
  maxInputChars: 4000,
  maxInputTokens: 3000,
  timeoutMs: 1000,
  outputLanguage: 'auto',
  outputStyle: 'sections',
  metaPromptLanguage: '中文',
  autoOptimize: true,
  autoOptimizePrefix: '/optimize ',
  minSectionChars: 10,
  maxTokenRetryFactor: 1.5,
  retryTemperatureStep: 0.3,
  skipIfAlreadyOptimized: false,
  selfRefine: false,
  templateId: 'default',
  autoOptimizeAll: false,
  hookIncludeOriginal: false,
  contextAware: false,
  contextMaxMessages: 6,
  contextMaxTokens: 1500,
}

const FOUR_SECTIONS = `## Role
专家

## Task
写周报

## Context
团队周会

## Format
Markdown`

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

type Listener = (payload: {
  agent: unknown
  messages: ReturnType<typeof userMessage>[]
  turn: number
  step: number
  signal: AbortSignal
}, next: () => Promise<unknown>) => Promise<unknown>

interface HookHarness {
  on: ReturnType<typeof vi.fn>
  listener: Listener | undefined
}

function makeHarness(): HookHarness {
  const state: HookHarness = { on: undefined as never, listener: undefined }
  const on = vi.fn((_event: string, handler: Listener) => {
    state.listener = handler
    return () => {}
  })
  state.on = on
  return state
}

function register(state: HookHarness, config: Config, service: PromptOptimizerService) {
  const ctx = { on: state.on } as never
  registerAutoOptimizeHook(ctx, config, service)
}

function nextDecision(messages: ReturnType<typeof userMessage>[]) {
  return vi.fn(async () => ({ kind: 'enter', messages }) as const)
}

describe('helpers', () => {
  it('extracts concatenated text blocks', () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: '前' },
        { type: 'text', text: '后' },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(messageText(message)).toBe('前后')
  })

  it('matches only when the prefix is present and non-empty', () => {
    expect(isTriggered('/optimize 写周报', '/optimize ')).toBe(true)
    expect(isTriggered('写周报', '/optimize ')).toBe(false)
    expect(isTriggered('写周报', '')).toBe(false)
  })

  it('builds a replacement message carrying the optimized prompt', () => {
    const message = optimizedMessage(FOUR_SECTIONS)
    const text = messageText(message)
    expect(text).toContain(AUTO_OPTIMIZE_NOTE)
    expect(text).toContain(FOUR_SECTIONS)
  })
})

describe('registerAutoOptimizeHook', () => {
  /** Mock service; `all` drives `isAutoOptimizeAll()` (the hook reads it live). */
  function mockService(optimizeImpl: () => Promise<unknown>, all = false) {
    const optimize = vi.fn((_rawInput: string, _options?: OptimizeOptions) => optimizeImpl())
    const service = {
      optimize,
      isAutoOptimizeAll: vi.fn(() => all),
    } as unknown as PromptOptimizerService
    return { service, optimize }
  }

  it('does not register when autoOptimize is disabled', () => {
    const state = makeHarness()
    register(state, { ...BASE_CONFIG, autoOptimize: false }, {} as PromptOptimizerService)
    expect(state.on).not.toHaveBeenCalled()
  })

  it('replaces a triggered message with the optimized prompt', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }))
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    const decision = await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )

    expect(service.optimize).toHaveBeenCalledWith('帮我写周报', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(decision).toEqual({ kind: 'enter', messages: [expect.any(Object)] })
    const replaced = (decision as { kind: 'enter'; messages: ReturnType<typeof userMessage>[] }).messages[0]
    expect(messageText(replaced)).toContain(FOUR_SECTIONS)
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves the message when the prefix is absent', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => null)
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('普通消息，没有触发前缀')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    expect(service.optimize).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it('preserves the message when optimization fails', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => { throw new Error('model exploded') })
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    expect(next).toHaveBeenCalled()
  })

  it('preserves the message when optimization falls back unoptimized', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => ({ prompt: '/optimize 帮我写周报', optimized: false, error: 'missing sections', retries: 1 }))
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    expect(next).toHaveBeenCalled()
  })

  it('optimizes at most one message per step', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }))
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('/optimize 第一条'), userMessage('/optimize 第二条')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    expect(service.optimize).toHaveBeenCalledTimes(1)
  })

  it('optimizes every text message when the runtime all-mode is on', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }), true)
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('普通消息，没有触发前缀')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    // The full text is the instruction (no prefix stripped).
    expect(service.optimize).toHaveBeenCalledWith('普通消息，没有触发前缀', expect.anything())
    expect(next).not.toHaveBeenCalled()
  })

  it('keeps the original instruction in the replacement when hookIncludeOriginal', async () => {
    const state = makeHarness()
    const { service } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }))
    register(state, { ...BASE_CONFIG, hookIncludeOriginal: true }, service)

    const messages = [userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    const decision = await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    const replaced = (decision as { kind: 'enter'; messages: ReturnType<typeof userMessage>[] }).messages[0]
    const text = messageText(replaced)
    expect(text).toContain('帮我写周报')
    expect(text).toContain(FOUR_SECTIONS)
  })

  it('passes no context when contextAware is off', async () => {
    const state = makeHarness()
    const { service, optimize } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }))
    register(state, BASE_CONFIG, service)

    const messages = [userMessage('上一轮'), userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    const options = optimize.mock.calls[0]![1]
    expect(options?.context).toBeUndefined()
  })

  it('gathers prior messages as context when contextAware is on', async () => {
    const state = makeHarness()
    const { service, optimize } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }))
    register(state, { ...BASE_CONFIG, contextAware: true, contextMaxMessages: 6, contextMaxTokens: 1500 }, service)

    const messages = [userMessage('第一轮：明确了需求'), userMessage('第二轮：预算 5 万'), userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    const options = optimize.mock.calls[0]![1]
    expect(options?.context).toContain('第一轮：明确了需求')
    expect(options?.context).toContain('第二轮：预算 5 万')
    // The instruction itself (with its trigger prefix) is not part of the context.
    expect(options?.context).not.toContain('帮我写周报')
  })

  it('omits the context key when there are no prior messages', async () => {
    const state = makeHarness()
    const { service, optimize } = mockService(async () => ({ prompt: FOUR_SECTIONS, optimized: true, retries: 0 }))
    register(state, { ...BASE_CONFIG, contextAware: true }, service)

    const messages = [userMessage('/optimize 帮我写周报')]
    const next = nextDecision(messages)
    await state.listener!(
      { agent: {}, messages, turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    const options = optimize.mock.calls[0]![1]
    expect(options?.context).toBeUndefined()
  })
})
