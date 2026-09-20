/**
 * Local timeout arithmetic, signal fusion and classification.
 *
 * Why this exists (1.8.2): the plugin imported `deadline`, `timeoutOf` and
 * `MAX_TIMER_DELAY_MS` from `@deepseek-ai/dsh-timeout`. That is a *domain* peer
 * — a package the harness may rename, split or move at any rc release — and a
 * static import of it means a single missing export takes the whole `dsh web`
 * process down with it. The three helpers used here are small, fully specified
 * by their contracts, and have no dependency on harness internals, so the
 * plugin now owns them.
 *
 * Behaviour matches the harness implementation it replaces, with one deliberate
 * hardening: {@link timeoutOf} classifies by *shape* (`name` / `code` /
 * `timeoutMs`) rather than `instanceof`. That way a timeout reason raised by
 * the harness's own copy of the helper — for example when a nested upstream
 * deadline aborts us — is still recognised as a timeout instead of being
 * misreported as an ordinary cancellation.
 */
/** Largest delay Node schedules without clamping it to one millisecond (2^31−1). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * Abort reason carrying a capability-owned timeout code and the elapsed
 * deadline. Capabilities translate it through {@link timeoutOf} before
 * returning to callers.
 */
export class TimeoutReason extends Error {
    code;
    timeoutMs;
    constructor(code, timeoutMs) {
        super(`${code} after ${timeoutMs}ms`);
        this.code = code;
        this.timeoutMs = timeoutMs;
        this.name = 'TimeoutReason';
    }
}
/** Validate a timer delay, mirroring the harness helper's contract. */
function assertTimerDelay(timeoutMs, name) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
    }
}
/**
 * Fuse upstream cancellation with an identifiable timeout.
 *
 * @param upstream The caller's cancellation signal, if any, fused into the result.
 * @param timeoutMs Deadline in milliseconds; `<= 0` means "no timeout" (arm no timer).
 * @param code Capability-owned code stamped onto the timeout's {@link TimeoutReason}.
 * @returns The fused {@link Deadline} (signal + timer cleanup). The signal only
 *   notifies, so the caller still has to stop its own work.
 */
export function deadline(upstream, timeoutMs, code) {
    if (timeoutMs <= 0) {
        return {
            signal: upstream ?? new AbortController().signal,
            [Symbol.dispose]() { },
        };
    }
    assertTimerDelay(timeoutMs, 'deadline timeoutMs');
    const timer = new AbortController();
    const id = setTimeout(() => {
        timer.abort(new TimeoutReason(code, timeoutMs));
    }, timeoutMs);
    return {
        signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
        [Symbol.dispose]() {
            clearTimeout(id);
        },
    };
}
/**
 * Classify a reason carrier as a timeout. Shape-based on purpose (see the
 * module docstring): `reason.name === 'TimeoutReason'` matches both this copy
 * and any other copy of the helper in the same process.
 */
function asTimeoutReason(reason) {
    if (reason === null || typeof reason !== 'object')
        return undefined;
    const candidate = reason;
    if (candidate.name !== 'TimeoutReason')
        return undefined;
    if (typeof candidate.code !== 'string' || typeof candidate.timeoutMs !== 'number')
        return undefined;
    return reason;
}
/**
 * Recover a timeout reason from a reason-bearing object.
 *
 * @param x An `AbortSignal` or any `{ reason }` carrier (e.g. a caught abort error).
 * @param code When provided, only a reason with this exact `code` matches; a
 *   foreign code follows the ordinary cancellation path.
 * @returns The matching reason, else `undefined`.
 */
export function timeoutOf(x, code) {
    const reason = asTimeoutReason(x.reason);
    if (reason === undefined)
        return undefined;
    return code === undefined || reason.code === code ? reason : undefined;
}
