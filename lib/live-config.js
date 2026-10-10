/**
 * Live configuration: the handshake behind a settings-panel edit that does not
 * restart the plugin.
 *
 * The loader hands a plugin its config object, but every field the schema declares
 * `volatile()` arrives as a **reference**, not a value (cosmokit's `Volatile`:
 * `{ get() }`). An edit touching only those fields is committed *in place* —
 * `updateVolatile(ref, next)` rewrites the reference's contents instead of
 * re-instantiating the plugin — and the loader then emits `loader/volatile-update`
 * on the plugin's own fiber.
 * A plugin reading `this.config.x` therefore needs a **plain-value** copy (a
 * reference is truthy and passes every `if (this.config.someFlag)` test) plus a
 * refresh when `loader/volatile-update` fires — pure data work, so it lives here.
 * @module live-config
 */
/**
 * cosmokit's marker for a volatile reference.
 *
 * Deliberately `Symbol.for`: two copies of the shared library (this package's
 * own `@deepseek-ai/schemastery`/`cosmokit` and the host's) must recognise each
 * other's references, and a registry symbol is the only identity that survives
 * the copy. `cosmokit` uses the very same expression.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
/** The loader event emitted after volatile references were committed in place. */
export const VOLATILE_UPDATE_EVENT = 'loader/volatile-update';
/**
 * Whether `value` is a volatile config reference.
 *
 * The test is the protocol marker, not the class: the host may have supplied
 * references built by its own copy of cosmokit, and those must be recognised.
 * @param value - a resolved config field.
 * @returns true when the field is a reference rather than a plain value.
 */
export function isVolatileRef(value) {
    return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}
/** The current plain value of a config field, reference or not. */
function plainValue(value) {
    return isVolatileRef(value) ? value.get() : value;
}
/**
 * Build a plain-value copy of a resolved config.
 *
 * Only the top level is unwrapped: the schema declares `volatile` on scalar
 * top-level keys only (see `LIVE_CONFIG_KEYS` in `config.ts`). A nested
 * `volatile` node would need a recursive walk here, so `tests/live-config.test.ts`
 * asserts that the schema's volatile keys are exactly the expected ones.
 * @param source - the config object the loader resolved.
 * @returns a fresh object whose fields are plain values.
 */
export function plainConfig(source) {
    const target = {};
    return adoptLiveConfig(target, source);
}
/**
 * Copy `source` onto `target` in place, unwrapping references to their current
 * values.
 *
 * In place on purpose: the service keeps ONE config object for its whole life
 * and hands it to the tool / hook / command layers, so replacing it would leave
 * those holding a stale object. Mutating it means a panel edit reaches every
 * reader at once.
 * @param target - the object to update (returned unchanged for chaining).
 * @param source - the loader-resolved config, possibly holding references.
 * @returns `target`.
 */
export function adoptLiveConfig(target, source) {
    const into = target;
    const from = source;
    for (const key of Object.keys(from)) {
        into[key] = plainValue(from[key]);
    }
    return target;
}
/**
 * Keep `target` in step with `source` for as long as the plugin lives.
 *
 * `ctx` is taken structurally (not as a cordis `Context`) for one deliberate
 * reason: the event name is the *host loader's* contract, not something this
 * package declares, so importing it into our event typings would mean
 * re-declaring a host internal. The only requirement is a cordis-shaped `on`,
 * which disposes the listener together with the context.
 *
 * @param ctx - the plugin context (must expose cordis' `on` to be registered).
 * @param target - the plain-value snapshot to refresh.
 * @param source - the loader-resolved config holding the live references.
 * @returns true when a listener was registered; false on a context without `on`.
 */
export function followVolatileUpdates(ctx, target, source) {
    const on = ctx?.on;
    if (typeof on !== 'function')
        return false;
    on.call(ctx, VOLATILE_UPDATE_EVENT, () => {
        adoptLiveConfig(target, source);
    });
    return true;
}
