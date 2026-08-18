import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { OptimizeError, OPTIMIZE_ERROR_TEXT } from './errors.js'
import type { PromptOptimizerService } from './optimizer.js'

/** Stable machine-readable token for the current role-document language mode. */
export function metaLanguageToken(language: 'auto' | 'zh' | 'en'): string {
  if (language === 'auto') return 'META_LANGUAGE:AUTO'
  return language === 'en' ? 'META_LANGUAGE:EN' : 'META_LANGUAGE:ZH'
}

/**
 * Register the `/optimize` and `/auto-optimize` commands. The browser client
 * drives the input-box buttons through the already-generated `commands` Remote
 * namespace (`ctx.remote.commands.execute(sessionId, ...)`) — the one
 * client→host RPC path that ships with strict descriptors and is guaranteed to
 * be claimed by the host gateway (custom `@Remote` namespaces require SRC
 * discovery, which is unreliable in deployed compositions).
 *
 * Effect-scoped: the registrations are removed on plugin dispose.
 */
export function registerOptimizeCommand(ctx: Context, service: PromptOptimizerService): void {
  ctx.commands.register({
    name: 'optimize',
    description: 'Optimize a raw instruction into a professional optimized prompt',
    input: { hint: '请输入要优化的原始指令，例如：帮我写一份周报' },
    handler: async (invocation): Promise<CommandResult> => {
      const text = invocation.rawInput.trim()
      if (text.length === 0) {
        return { kind: 'error', text: 'prompt-optimize: 请提供要优化的指令' }
      }
      try {
        const result = await service.optimize(text, { signal: invocation.signal })
        if (result.optimized) return { kind: 'success', text: result.prompt }
        return { kind: 'error', text: result.error ?? 'prompt-optimize: 优化失败' }
      } catch (error) {
        if (error instanceof OptimizeError) {
          return { kind: 'error', text: OPTIMIZE_ERROR_TEXT[error.code] }
        }
        return { kind: 'error', text: `prompt-optimize: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
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
}
