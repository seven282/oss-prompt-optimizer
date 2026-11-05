import { describe, expect, it, vi } from 'vitest'

// A host whose probed capabilities the test controls. Mocking the probe (not
// the imports) keeps the module graph intact and lets the real constructor /
// registration / stream paths run under every degradation shape.
const caps = vi.hoisted(() => ({
  value: { defineTool: null, createUserMessage: null, BlockAssembler: null } as {
    defineTool: unknown
    createUserMessage: unknown
    BlockAssembler: unknown
  },
}))

vi.mock('../src/compat/capability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compat/capability.js')>()
  return { ...actual, probeCapabilities: () => caps.value }
})

import { probeCapabilities } from '../src/compat/capability.js'
import { registerPromptOptimizeTool } from '../src/tool.js'
import { PromptOptimizerService } from '../src/optimizer.js'
import type { Config } from '../src/config.js'

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
}

function makeHost() {
  const warns: string[] = []
  const infos: string[] = []
  const tools: unknown[] = []
  const ctx = {
    reflect: { provide: () => {} },
    get: () => undefined,
    emit: () => {},
    tools: { register: (def: unknown) => { tools.push(def); return () => {} } },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    llm: { stream: () => { throw new Error('a degraded host must not be called') } },
    logger: {
      info: (msg: string) => infos.push(msg),
      warn: (msg: string) => warns.push(msg),
    },
  }
  return { ctx, warns, infos, tools }
}

const service = (host: ReturnType<typeof makeHost>) =>
  new PromptOptimizerService(host.ctx as never, DEFAULT_CONFIG)

/** Reset the probe to "nothing is available" before each degradation test. */
function allMissing(): void {
  caps.value = { defineTool: null, createUserMessage: null, BlockAssembler: null }
}

describe('degraded host', () => {
  it('logs the degradation instead of claiming a healthy start', () => {
    allMissing()
    const host = makeHost()
    service(host)
    expect(host.infos).toEqual([])
    expect(host.warns.join('\n')).toContain('host compat DEGRADED')
  })

  it('reports that it cannot assemble a stream', () => {
    allMissing()
    const instance = service(makeHost())
    expect(instance.canAssembleStream()).toBe(false)
    expect(instance.hostCapabilities()).toEqual({ defineTool: null, createUserMessage: null, BlockAssembler: null })
  })

  it('fails an optimization loudly, naming both missing capabilities', async () => {
    allMissing()
    const instance = service(makeHost())
    await expect(instance.optimize('写一份周报，面向团队'))
      .rejects.toThrow(/does not expose @deepseek-ai\/dsh-llm#createUserMessage, @deepseek-ai\/dsh-llm#BlockAssembler/)
  })

  it('registers no tool when the probe found no defineTool', () => {
    allMissing()
    const host = makeHost()
    registerPromptOptimizeTool(host.ctx as never, DEFAULT_CONFIG, {} as never, probeCapabilities())
    expect(host.tools).toHaveLength(0)
    expect(host.warns.join('\n')).toContain('defineTool')
  })

  // Partial degradation: exactly one capability is missing, so the error must
  // name that one alone — a message listing the wrong thing is worse than none.
  it('names only the message factory when only that capability is gone', async () => {
    caps.value = { defineTool: null, createUserMessage: null, BlockAssembler: {} }
    const instance = service(makeHost())
    expect(instance.canAssembleStream()).toBe(false)
    await expect(instance.optimize('写一份周报，面向团队'))
      .rejects.toThrow(/does not expose @deepseek-ai\/dsh-llm#createUserMessage$/)
  })

  it('names only the block assembler when only that capability is gone', async () => {
    caps.value = { defineTool: null, createUserMessage: {}, BlockAssembler: null }
    const instance = service(makeHost())
    expect(instance.canAssembleStream()).toBe(false)
    await expect(instance.optimize('写一份周报，面向团队'))
      .rejects.toThrow(/does not expose @deepseek-ai\/dsh-llm#BlockAssembler$/)
  })
})
