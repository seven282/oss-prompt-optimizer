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

import type { OptimizeResult } from './optimizer.js'

/** Which public entry point produced the event. */
export type OptimizeMethod = 'optimize' | 'iterate'

/** Payload of `prompt-optimizer/optimize:start` (input validated, first model call pending). */
export interface OptimizeStartPayload {
  method: OptimizeMethod
  /** The raw input: the original instruction (`optimize`) or the previous result (`iterate`). */
  input: string
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
