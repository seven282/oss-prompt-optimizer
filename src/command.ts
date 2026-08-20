import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { OptimizeError, OPTIMIZE_ERROR_TEXT } from './errors.js'
import { gatherConversationContext, type ContextMessage } from './context.js'
import type { PromptOptimizerService } from './optimizer.js'

/** Stable machine-readable token for the current role-document language mode. */
export function metaLanguageToken(language: 'auto' | 'zh' | 'en'): string {
  if (language === 'auto') return 'META_LANGUAGE:AUTO'
  return language === 'en' ? 'META_LANGUAGE:EN' : 'META_LANGUAGE:ZH'
}

/**
 * Best-effort conversation context from the receiving agent's live session.
 * The exact session API is duck-typed (`agent.session.deriveMessages()`),
 * so a missing method or any error yields `undefined` — the optimization
 * then simply runs without context. Session messages include the current
 * command record; the last message is dropped so the command line itself is
 * not treated as user context.
 */
function sessionContext(
  agent: { session?: unknown } | undefined,
  service: PromptOptimizerService,
): string | undefined {
  if (agent === undefined || !service.isContextAware()) return undefined
  try {
    const session = agent.session as { deriveMessages?: () => unknown } | undefined
    const derive = session?.deriveMessages
    if (typeof derive !== 'function') return undefined
    const messages = (derive.call(session) ?? []) as ContextMessage[]
    if (messages.length === 0) return undefined
    const prior = messages.slice(0, -1)
    if (prior.length === 0) return undefined
    const bounds = service.contextConfig()
    return gatherConversationContext(prior, {
      maxMessages: bounds.maxMessages,
      maxTokens: bounds.maxTokens,
    })
  } catch {
    // Context is best-effort; never fail the command over it.
    return undefined
  }
}

/**
 * Register the `/optimize`, `/auto-optimize`, `/optimizer-language` and
 * `/optimize-stats` commands. The browser client drives the input-box buttons
 * through the already-generated `commands` Remote namespace
 * (`ctx.remote.commands.execute(sessionId, ...)`) — the one client→host RPC
 * path that ships with strict descriptors and is guaranteed to be claimed by
 * the host gateway (custom `@Remote` namespaces require SRC discovery, which
 * is unreliable in deployed compositions).
 *
 * Effect-scoped: the registrations are removed on plugin dispose.
 */
export function registerOptimizeCommand(ctx: Context, service: PromptOptimizerService): void {
  /** Shared optimize handler; `senseNeeds` enables the 造梦模式 appendix (/dream). */
  const optimizeHandler = async (invocation: {
    agent: unknown
    rawInput: string
    signal: AbortSignal
  }, senseNeeds: boolean): Promise<CommandResult> => {
    const text = invocation.rawInput.trim()
    if (text.length === 0) {
      return { kind: 'error', text: 'prompt-optimize: 请提供要优化的指令' }
    }
    try {
      const context = sessionContext(invocation.agent as { session?: unknown }, service)
      const result = await service.optimize(text, {
        signal: invocation.signal,
        senseNeeds,
        ...(context !== undefined && context.length > 0 ? { context } : {}),
      })
      if (result.optimized) return { kind: 'success', text: result.prompt }
      return { kind: 'error', text: result.error ?? 'prompt-optimize: 优化失败' }
    } catch (error) {
      if (error instanceof OptimizeError) {
        return { kind: 'error', text: OPTIMIZE_ERROR_TEXT[error.code] }
      }
      return { kind: 'error', text: `prompt-optimize: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.commands.register({
    name: 'optimize',
    description: 'Optimize a raw instruction into a professional optimized prompt',
    input: { hint: '请输入要优化的原始指令，例如：帮我写一份周报' },
    handler: (invocation) => optimizeHandler(invocation, false),
  })

  // 造梦模式 (阶段 3): same as /optimize but forces the 延伸洞察 appendix.
  ctx.commands.register({
    name: 'dream',
    description: 'Optimize with 需求感应 (dream mode): the result appends AI-inferred deep goal / constraints / quality / follow-ups',
    input: { hint: '请输入要优化的原始指令，例如：帮我写一份周报' },
    handler: (invocation) => optimizeHandler(invocation, true),
  })

  // Runtime switch for "optimize every message before the model step". The
  // client toggle button drives this through the strict commands Remote
  // namespace; results are machine-readable tokens the client maps back.
  ctx.commands.register({
    name: 'auto-optimize',
    description: 'Switch whether every message is auto-optimized before the model step (on | off | toggle | status)',
    input: { hint: 'on | off | toggle | status' },
    handler: async (invocation): Promise<CommandResult> => {
      const arg = invocation.rawInput.trim().toLowerCase()
      const current = service.isAutoOptimizeAll()
      let next: boolean
      switch (arg) {
        case 'on':
          next = true
          break
        case 'off':
          next = false
          break
        case 'toggle':
          next = !current
          break
        case 'status':
          return { kind: 'success', text: current ? 'AUTO_OPTIMIZE:ON' : 'AUTO_OPTIMIZE:OFF' }
        default:
          return { kind: 'error', text: 'prompt-optimize: 用法 /auto-optimize on | off | toggle | status' }
      }
      service.setAutoOptimizeAll(next)
      return { kind: 'success', text: next ? 'AUTO_OPTIMIZE:ON' : 'AUTO_OPTIMIZE:OFF' }
    },
  })

  // Runtime switch for the role-document language mode (auto | 中文 | 英文).
  // `auto` (the default) follows each instruction's language; 中文/英文 pin it.
  ctx.commands.register({
    name: 'optimizer-language',
    description: 'Switch the optimizer role-document language mode (auto | 中文 | 英文 | status)',
    input: { hint: 'auto | 中文 | 英文 | status' },
    handler: async (invocation): Promise<CommandResult> => {
      const arg = invocation.rawInput.trim()
      if (arg === 'status') {
        return { kind: 'success', text: metaLanguageToken(service.getMetaPromptLanguage()) }
      }
      if (arg === 'auto' || arg === '中文' || arg === '英文') {
        service.setMetaPromptLanguage(arg === 'auto' ? 'auto' : arg === '英文' ? 'en' : 'zh')
        return { kind: 'success', text: metaLanguageToken(service.getMetaPromptLanguage()) }
      }
      return { kind: 'error', text: 'prompt-optimize: 用法 /optimizer-language auto | 中文 | 英文 | status' }
    },
  })

  // Read-only run statistics (观测): machine-readable token the client maps
  // to a transient "consumed ≈N tokens" hint after a successful optimize, and
  // for latency diagnosis (last single-call ms + calls in the last run).
  ctx.commands.register({
    name: 'optimize-stats',
    description: 'Report optimizer run statistics (machine-readable tokens)',
    handler: async (): Promise<CommandResult> => {
      const stats = service.getStats()
      return {
        kind: 'success',
        text: `OPTIMIZE_STATS:TOKENS:${stats.lastOutputTokens}|INPUT:${stats.lastInputTokens}|CALLS:${stats.lastRunCalls}|LASTMSCALL:${stats.lastCallMs}`,
      }
    },
  })
}
