import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { type Capabilities } from './compat/capability.js';
import type { Config } from './config.js';
import type { OptimizeResult, PromptOptimizerService } from './optimizer.js';
/** Render the canonical value to model-facing text (pure, replay-safe). */
export declare function renderOptimizeResult(value: OptimizeResult): ContentBlock[];
/**
 * System-prompt guidance that tells the model the tool exists.
 *
 * Split out of {@link registerPromptOptimizeTool} (1.8.2) so it can be gated on
 * `systemPrompt` alone: if the host drops either service, only that half
 * disappears instead of both.
 */
export declare function registerPromptOptimizeGuidance(ctx: Context): void;
/**
 * Register the `prompt_optimize` tool. Both registrations are effect-scoped and
 * unregister on plugin dispose.
 *
 * `defineTool` is resolved through the compat layer (1.8.2) rather than being
 * imported from `@deepseek-ai/dsh-tools`. When the host does not expose it the
 * tool is simply not registered and one warning is logged — the `/optimize`
 * command and the input-box button keep working, because neither goes through
 * the tool registry.
 */
export declare function registerPromptOptimizeTool(ctx: Context, config: Config, service: PromptOptimizerService, capabilities?: Capabilities): void;
