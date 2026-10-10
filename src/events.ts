/**
 * Public lifecycle events emitted by the `promptOptimizer` service.
 *
 * Other plugins can subscribe through cordis's event bus, e.g.:
 *
 * ```ts
 * ctx.on('prompt-optimizer/optimize:success', ({ method, input, result, durationMs }) => { ... })
 * ```
 *
 * The events are fire-and-forget observers: a throwing listener is swallowed
 * at the emit site and never affects the optimization pipeline. `optimize`
 * and `iterate` share the same three events, distinguished by `method`.
 */

import type { ModelRoute, OptimizeResult } from './optimizer.js'
import type { SituationProfile } from './situation.js'

/** Which public entry point produced the event. */
export type OptimizeMethod = 'optimize' | 'iterate'

/** Payload of `prompt-optimizer/optimize:start` (input validated, first model call pending). */
export interface OptimizeStartPayload {
  method: OptimizeMethod
  /** The raw input: the original instruction (`optimize`) or the previous result (`iterate`). */
  input: string
  /** Optional situation profile (P2) — present when the pipeline computed one. */
  profile?: SituationProfile
}

/**
 * OpenTelemetry GenAI semantic-convention view of one run (1.13.0, benchmark
 * checklist item 7). The keys are the literal attribute names from the spec,
 * so the object can be handed straight to a span without a translation table:
 *
 * ```ts
 * ctx.on('prompt-optimizer/optimize:success', ({ genAi }) => {
 *   if (genAi) span.setAttributes(genAi)
 * })
 * ```
 *
 * **Absent when the run made no model call** — a cache hit and a local
 * zero-token render perform no inference, and an all-zero block would describe
 * a span that never existed. Inside the block the five usage attributes are
 * all-or-nothing: an adapter that reports no usage leaves them out instead of
 * reporting zeros, exactly as `RunUsage.calls` keeps "reported 0" and
 * "reported nothing" apart.
 *
 * `gen_ai.response.model` is deliberately NOT emitted: the harness reports the
 * model a request asked for, never a distinct model that served it, and
 * filling the field in would be a claim we cannot back.
 */
export interface GenAiSignal {
  /** Spec value for a chat completion — this plugin's only model operation. */
  'gen_ai.operation.name': 'chat'
  'gen_ai.provider.name': string
  'gen_ai.request.model': string
  /** The session that asked, when the caller supplied one. */
  'gen_ai.conversation.id'?: string
  'gen_ai.usage.input_tokens'?: number
  'gen_ai.usage.output_tokens'?: number
  'gen_ai.usage.cache_read.input_tokens'?: number
  'gen_ai.usage.cache_creation.input_tokens'?: number
  'gen_ai.usage.reasoning.output_tokens'?: number
}

/** Payload of `prompt-optimizer/optimize:success` / `prompt-optimizer/optimize:failure`. */
export interface OptimizeOutcomePayload {
  method: OptimizeMethod
  /** The raw input, as in `OptimizeStartPayload`. */
  input: string
  /** The service result: `optimized: true` for `success`, `false` for `failure`. */
  result: OptimizeResult
  /** Wall-clock time spent in the generation pipeline, in milliseconds. */
  durationMs: number
  /**
   * The model route the run actually used (1.13.0, benchmark checklist item 6):
   * the target model belongs in the record, not only in the request. Absent
   * when the run made no model call.
   */
  route?: ModelRoute
  /** The same facts under the OpenTelemetry GenAI names (1.13.0, item 7). */
  genAi?: GenAiSignal
}

/** The event names, exported for reference and to avoid retyping the literals. */
export const PROMPT_OPTIMIZER_EVENTS = {
  start: 'prompt-optimizer/optimize:start',
  success: 'prompt-optimizer/optimize:success',
  failure: 'prompt-optimizer/optimize:failure',
} as const

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A validation-passing optimization / iteration is about to call the model. */
    'prompt-optimizer/optimize:start'(payload: OptimizeStartPayload): void
    /** A validation-passing optimization / iteration finished with `optimized: true`. */
    'prompt-optimizer/optimize:success'(payload: OptimizeOutcomePayload): void
    /** A validation-passing optimization / iteration finished with `optimized: false` (fallback returned). */
    'prompt-optimizer/optimize:failure'(payload: OptimizeOutcomePayload): void
  }
}
