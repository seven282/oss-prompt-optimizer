import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { PromptOptimizerService, PROMPT_OPTIMIZER_TIMEOUT_CODE } from '../src/optimizer.js'
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
  maxRetries: 1,
  maxInputChars: 4000,
  maxInputTokens: 3000,
  timeoutMs: 1000,
  outputLanguage: 'auto',
  outputStyle: 'sections',
  metaPromptLanguage: 'auto',
  autoOptimize: false,
  autoOptimizePrefix: '/optimize ',
  minSectionChars: 0,
  maxTokenRetryFactor: 1.5,
  retryTemperatureStep: 0.3,
  skipIfAlreadyOptimized: false,
  selfRefine: false,
  templateId: 'default',
  autoOptimizeAll: false,
  hookIncludeOriginal: false,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
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

function makeService(makeStream: () => AsyncIterable<StreamChunk>): { service: PromptOptimizerService; commands: CommandDef[] } {
  const captured: CommandDef[] = []
  const ctx = {
    reflect: { provide: () => {} },
    get: () => undefined,
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: (def: CommandDef) => { captured.push(def); return () => {} } },
    llm: { stream: () => makeStream() },
  }
  const service = new PromptOptimizerService(ctx as never, DEFAULT_CONFIG)
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
  it('registers the /optimize, /auto-optimize and /optimizer-language commands', () => {
    const { commands } = makeService(() => textStream(FOUR_SECTIONS))
    expect(commands.map((c) => c.name)).toEqual(['optimize', 'auto-optimize', 'optimizer-language'])
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
