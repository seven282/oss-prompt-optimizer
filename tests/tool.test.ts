import { describe, expect, it, vi } from 'vitest'
import {
  registerPromptOptimizeGuidance,
  registerPromptOptimizeTool,
  renderOptimizeResult,
} from '../src/tool.js'
import type { Capabilities } from '../src/compat/capability.js'
import type { Config } from '../src/config.js'
import type { OptimizeResult } from '../src/optimizer.js'

const CONFIG = { timeoutMs: 4321 } as Config

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: unknown
    render: (args: unknown, value: OptimizeResult) => unknown
    presentationMeta: (args: unknown, value: OptimizeResult) => Record<string, unknown>
  }
  timeoutMs: number
  isConcurrencySafe: () => boolean
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
  presentCall: (args: { instruction: string }) => Record<string, unknown>
}

function makeHost() {
  const tools: ToolDef[] = []
  const sections: unknown[] = []
  const warnings: unknown[][] = []
  const ctx = {
    tools: { register: (def: ToolDef) => { tools.push(def); return () => {} } },
    systemPrompt: { section: (def: unknown) => { sections.push(def); return () => {} } },
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
  }
  return { ctx, tools, sections, warnings }
}

function makeService() {
  const optimize = vi.fn(async () => ({ prompt: 'P', optimized: true, retries: 0 } as OptimizeResult))
  const iterate = vi.fn(async () => ({ prompt: 'I', optimized: true, retries: 1 } as OptimizeResult))
  return { optimize, iterate }
}

describe('registerPromptOptimizeTool', () => {
  it('registers the tool with its schema, timeout and concurrency flag', () => {
    const host = makeHost()
    const service = makeService()
    registerPromptOptimizeTool(host.ctx as never, CONFIG, service as never)
    expect(host.tools).toHaveLength(1)
    const def = host.tools[0]!
    expect(def.name).toBe('prompt_optimize')
    expect(def.description).toContain('Optimize a raw instruction')
    // defineTool normalizes the declared parameters into a JSON schema.
    const schema = def.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual([
      'instruction', 'temperature', 'maxTokens', 'lastOptimized', 'iterateInstruction', 'localTemplate',
    ])
    expect(schema.required).toContain('instruction')
    expect(def.timeoutMs).toBe(4321)
    // The host wraps the predicate: it validates the arguments first, so a
    // schemaless call is (correctly) treated as non-safe.
    const safe = (def as unknown as { isConcurrencySafe: (args: Record<string, unknown>) => boolean }).isConcurrencySafe
    expect(safe({ instruction: '写周报' })).toBe(true)
    expect(safe({})).toBe(false)
    expect(def.presentCall({ instruction: '写周报' })).toEqual({
      card: 'generic', title: 'prompt_optimize', kind: 'other', rawInput: '写周报',
    })
  })

  it('optimizes with the optional per-call overrides', async () => {
    const host = makeHost()
    const service = makeService()
    registerPromptOptimizeTool(host.ctx as never, CONFIG, service as never)
    const signal = new AbortController().signal
    await host.tools[0]!.execute(
      { instruction: '写周报', temperature: 0.5, maxTokens: 900, localTemplate: 'hybrid' },
      { signal },
    )
    expect(service.optimize).toHaveBeenCalledWith('写周报', { signal, temperature: 0.5, maxTokens: 900, localTemplate: 'hybrid' })
    expect(service.iterate).not.toHaveBeenCalled()
  })

  it('sends only the signal when no override is given', async () => {
    const host = makeHost()
    const service = makeService()
    registerPromptOptimizeTool(host.ctx as never, CONFIG, service as never)
    const signal = new AbortController().signal
    await host.tools[0]!.execute({ instruction: '写周报' }, { signal })
    expect(service.optimize).toHaveBeenCalledWith('写周报', { signal })
  })

  it('iterates when lastOptimized is present, defaulting a missing instruction to empty', async () => {
    const host = makeHost()
    const service = makeService()
    registerPromptOptimizeTool(host.ctx as never, CONFIG, service as never)
    const signal = new AbortController().signal
    await host.tools[0]!.execute({ instruction: '写周报', lastOptimized: '上一版' }, { signal })
    expect(service.iterate).toHaveBeenCalledWith('上一版', '', { signal })
    expect(service.optimize).not.toHaveBeenCalled()
  })

  it('renders the prompt on success and an explicit fallback label on failure', () => {
    expect(renderOptimizeResult({ prompt: 'P', optimized: true, retries: 0 })).toEqual([{ type: 'text', text: 'P' }])
    const failed = renderOptimizeResult({
      prompt: '原始指令', optimized: false, retries: 2, errorCode: 'TIMEOUT' as never, error: 'deadline',
    })
    const text = (failed[0] as { text: string }).text
    expect(text).toContain('ORIGINAL instruction')
    expect(text).toContain('[TIMEOUT] deadline')
    // Absent code/message still render honestly instead of printing `undefined`.
    const bare = (renderOptimizeResult({ prompt: 'x', optimized: false, retries: 0 })[0] as { text: string }).text
    expect(bare).toContain('[UNKNOWN] unknown error')
  })

  it('reports only the metadata the result actually carries', () => {
    const host = makeHost()
    registerPromptOptimizeTool(host.ctx as never, CONFIG, makeService() as never)
    const meta = host.tools[0]!.output.presentationMeta
    expect(meta({}, { prompt: 'p', optimized: true, retries: 0 })).toEqual({ optimized: true, retries: 0 })
    expect(meta({}, {
      prompt: 'p', optimized: true, retries: 1, outputTokens: 12, local: true,
      sections: [{ name: 'Role', content: 'r' }],
    })).toEqual({
      optimized: true, retries: 1, outputTokens: 12,
      sections: [{ name: 'Role', content: 'r' }], local: true,
    })
    expect(host.tools[0]!.output.render({}, { prompt: 'p', optimized: true, retries: 0 })).toEqual([{ type: 'text', text: 'p' }])
  })

  it('skips registration and warns when the host has no defineTool', () => {
    const host = makeHost()
    const caps: Capabilities = { defineTool: null, createUserMessage: null, BlockAssembler: null }
    registerPromptOptimizeTool(host.ctx as never, CONFIG, makeService() as never, caps)
    expect(host.tools).toHaveLength(0)
    expect(String(host.warnings[0]?.[0])).toContain('defineTool')
  })

  it('registers the guidance section independently of the tool', () => {
    const host = makeHost()
    registerPromptOptimizeGuidance(host.ctx as never)
    expect(host.sections).toHaveLength(1)
    expect(host.sections[0]).toMatchObject({ name: 'tool:prompt_optimize', order: 112 })
  })
})
