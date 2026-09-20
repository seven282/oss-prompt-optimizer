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
/** The event names, exported for reference and to avoid retyping the literals. */
export const PROMPT_OPTIMIZER_EVENTS = {
    start: 'prompt-optimizer/optimize:start',
    success: 'prompt-optimizer/optimize:success',
    failure: 'prompt-optimizer/optimize:failure',
};
