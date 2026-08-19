import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import { contextMessageText, gatherConversationContext } from './context.js'
import type { PromptOptimizerService } from './optimizer.js'

/**
 * Concatenated text of one user message's text blocks (skips tool-result etc.).
 * Delegates to `contextMessageText` — the single shared text-extraction
 * implementation (kept as a public alias because `index.ts` re-exports it).
 */
export function messageText(message: UserMessage): string {
  return contextMessageText(message)
}

/** Whether a message text carries the configured auto-optimize trigger. */
export function isTriggered(text: string, prefix: string): boolean {
  return prefix.length > 0 && text.startsWith(prefix)
}

/** Short note prefixed to the replacement so the model knows the text was optimized. */
export const AUTO_OPTIMIZE_NOTE = '（原始指令已由 prompt-optimizer 自动优化为以下提示词，请按此执行）'

/**
 * Build the replacement user message carrying the optimized prompt. When
 * `includeOriginal` is true, the original instruction text is kept alongside
 * the optimized prompt so the model can compare wording.
 */
export function optimizedMessage(optimized: string, includeOriginal = false, original = ''): UserMessage {
  const body = includeOriginal && original.length > 0
    ? `原始指令：\n${original}\n\n优化后提示词：\n${optimized}`
    : optimized
  return createUserMessage({
    content: [{ type: 'text', text: `${AUTO_OPTIMIZE_NOTE}\n\n${body}` }],
    source: { kind: 'plugin', plugin: 'prompt-optimizer' },
  })
}

/**
 * Register the auto-optimize hook: an `agent/pre-step` waterfall listener that
 * replaces the first eligible user message with the optimized prompt before it
 * enters the model step. No-op when `config.autoOptimize` is false.
 *
 * A message is eligible when it carries the trigger prefix, or — with
 * `config.autoOptimizeAll` — when it has any non-empty text. The prefix is
 * stripped before optimization. With `config.contextAware`, the messages
 * before the eligible one are gathered (bounded by `contextMaxMessages` /
 * `contextMaxTokens`) and injected as conversation context. Graceful
 * degradation: an empty instruction or any optimization failure preserves
 * the original messages (`next()`). At most one message per step is
 * optimized. Effect-scoped: the listener is removed on plugin dispose.
 */
export function registerAutoOptimizeHook(
  ctx: Context,
  config: Config,
  service: PromptOptimizerService,
): void {
  if (!config.autoOptimize) return
  const prefix = config.autoOptimizePrefix
  ctx.on('agent/pre-step', async (payload, next) => {
    let attempted = false
    let replaced = false
    const nextMessages: UserMessage[] = []
    for (let index = 0; index < payload.messages.length; index++) {
      const message = payload.messages[index]
      const text = messageText(message)
      // All-mode (config `autoOptimizeAll` or the runtime `/auto-optimize`
      // switch) optimizes every non-empty text message; otherwise only
      // trigger-prefixed messages are eligible.
      const allMode = service.isAutoOptimizeAll()
      const matches = allMode ? text.trim().length > 0 : isTriggered(text, prefix)
      if (!attempted && matches) {
        attempted = true
        const instruction = (allMode ? text : text.slice(prefix.length)).trim()
        // Context-aware mode: the messages before this one are the
        // conversation context; the instruction itself is excluded.
        const context = config.contextAware
          ? gatherConversationContext(payload.messages.slice(0, index), {
              maxMessages: config.contextMaxMessages,
              maxTokens: config.contextMaxTokens,
            })
          : ''
        try {
          const result = await service.optimize(instruction, {
            signal: payload.signal,
            ...(context.length > 0 ? { context } : {}),
          })
          if (result.optimized) {
            nextMessages.push(optimizedMessage(result.prompt, config.hookIncludeOriginal, instruction))
            replaced = true
            continue
          }
        } catch {
          // Optimization failed (model error, timeout, cancellation): keep the
          // original message and let the step proceed unoptimized.
        }
      }
      nextMessages.push(message)
    }
    if (!replaced) return next()
    return { kind: 'enter', messages: nextMessages }
  })
}
