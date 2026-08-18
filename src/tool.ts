import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import { OptimizeErrorCode } from './errors.js'
import type { OptimizeResult, PromptOptimizerService } from './optimizer.js'

/** Tool-facing description for `prompt_optimize`. */
export const PROMPT_OPTIMIZE_DESCRIPTION =
  'Optimize a raw instruction into a professional, ready-to-execute prompt. Returns the optimized prompt text. ' +
  'To iterate on an already optimized prompt, pass it as `lastOptimized` together with the new requirement as `iterateInstruction`.'

/** Render the canonical value to model-facing text (pure, replay-safe). */
export function renderOptimizeResult(value: OptimizeResult): ContentBlock[] {
  if (value.optimized) {
    return [{ type: 'text', text: value.prompt }]
  }
  // Explicit fallback labeling: the caller must not mistake the original for
  // the optimized prompt.
  return [
    {
      type: 'text',
      text: `⚠️ Prompt optimization failed, the following is the ORIGINAL instruction (not an optimized prompt):\n\n${value.prompt}\n\nReason: [${value.errorCode ?? 'UNKNOWN'}] ${value.error ?? 'unknown error'}`,
    },
  ]
}

/**
 * Register the `prompt_optimize` tool and its system-prompt guidance. Both
 * registrations are effect-scoped and unregister on plugin dispose.
 */
export function registerPromptOptimizeTool(
  ctx: Context,
  config: Config,
  service: PromptOptimizerService,
): void {
  ctx.tools.register(
    defineTool({
      name: 'prompt_optimize',
      description: PROMPT_OPTIMIZE_DESCRIPTION,
      parameters: {
        instruction: {
          type: 'string',
          required: true,
          description: 'The raw instruction to optimize into a professional prompt.',
        },
        temperature: {
          type: 'number',
          description: 'Optional sampling-temperature override for this call (0–2).',
        },
        maxTokens: {
          type: 'integer',
          description: 'Optional max-output-token override for this call.',
        },
        lastOptimized: {
          type: 'string',
          description: 'A previously optimized prompt to iterate on. When present, `iterateInstruction` must also be provided and the tool iterates instead of optimizing from scratch.',
        },
        iterateInstruction: {
          type: 'string',
          description: 'The new requirement to apply to `lastOptimized` (only valid together with `lastOptimized`).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', required: true },
            optimized: { type: 'boolean', required: true },
            error: { type: 'string' },
            errorCode: { type: 'string', enum: [...Object.values(OptimizeErrorCode)] },
            retries: { type: 'integer', required: true },
            outputTokens: { type: 'integer' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  content: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => renderOptimizeResult(value),
        presentationMeta: (_args, value) => ({
          optimized: value.optimized,
          retries: value.retries,
          ...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens } : {}),
          ...(value.sections !== undefined ? { sections: value.sections } : {}),
        }),
      },
      timeoutMs: config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const base = {
          signal: exec.signal,
          ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
        }
        if (args.lastOptimized !== undefined) {
          return service.iterate(args.lastOptimized, args.iterateInstruction ?? '', base)
        }
        return service.optimize(args.instruction, base)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'prompt_optimize',
        kind: 'other',
        rawInput: args.instruction,
      }),
    }),
  )
  ctx.systemPrompt.section({
    name: 'tool:prompt_optimize',
    order: 112,
    text: 'Use the prompt_optimize tool to turn a raw instruction into a professional optimized prompt. Pass the raw instruction as `instruction`; temperature and maxTokens are optional per-call overrides.',
  })
}
