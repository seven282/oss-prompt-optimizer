import type { Context } from '@deepseek-ai/cordis';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { type Capabilities } from './compat/capability.js';
import type { Config } from './config.js';
import type { PromptOptimizerService } from './optimizer.js';
/**
 * Concatenated text of one user message's text blocks (skips tool-result etc.).
 * Delegates to `contextMessageText` — the single shared text-extraction
 * implementation (kept as a public alias because `index.ts` re-exports it).
 */
export declare function messageText(message: UserMessage): string;
/** Whether a message text carries the configured auto-optimize trigger. */
export declare function isTriggered(text: string, prefix: string): boolean;
/** Short note prefixed to the replacement so the model knows the text was optimized. */
export declare const AUTO_OPTIMIZE_NOTE = "\uFF08\u539F\u59CB\u6307\u4EE4\u5DF2\u7531 prompt-optimizer \u81EA\u52A8\u4F18\u5316\u4E3A\u4EE5\u4E0B\u63D0\u793A\u8BCD\uFF0C\u8BF7\u6309\u6B64\u6267\u884C\uFF09";
/**
 * Build the replacement user message carrying the optimized prompt. When
 * `includeOriginal` is true, the original instruction text is kept alongside
 * the optimized prompt so the model can compare wording.
 *
 * `createUserMessage` is resolved through the compat layer (1.8.2) instead of
 * being imported from `@deepseek-ai/dsh-llm`, so a harness upgrade that drops
 * the export degrades the auto-optimize hook rather than breaking the process.
 * Passing a capability set explicitly lets callers reuse one probe result.
 */
export declare function optimizedMessage(optimized: string, includeOriginal?: boolean, original?: string, capabilities?: Capabilities): UserMessage;
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
 *
 * Degradation (1.8.2): when the host exposes no `createUserMessage`, the
 * replacement message cannot be built, so the hook is not registered at all and
 * a single warning is logged. Everything else keeps working.
 */
export declare function registerAutoOptimizeHook(ctx: Context, config: Config, service: PromptOptimizerService, capabilities?: Capabilities): void;
