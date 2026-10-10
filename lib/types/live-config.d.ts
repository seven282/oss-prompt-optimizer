/**
 * Live configuration: the handshake behind a settings-panel edit that does not
 * restart the plugin.
 *
 * dsh's loader hands a plugin its config object, but every field the Config
 * schema declares `volatile()` arrives as a **reference** rather than a value
 * (cosmokit's `Volatile`: `{ get() }`). A profile edit that touches only those
 * fields is committed *in place* — `updateVolatile(ref, next)` rewrites the
 * reference's contents instead of re-instantiating the plugin — and the loader
 * then emits `loader/volatile-update` on the plugin's own fiber
 * (`cordis-plugin-loader`: `equalExceptVolatile` → `_commitVolatile` → emit).
 *
 * A plugin that reads `this.config.x` therefore has to do two things:
 *
 * 1. keep its own **plain-value** copy of the config (that is what this module
 *    produces), because a reference is truthy and would silently pass every
 *    `if (this.config.someFlag)` test;
 * 2. refresh that copy when `loader/volatile-update` fires.
 *
 * Both steps are pure data work, so they live here rather than inside the
 * service: no harness import, no I/O, independently unit-testable.
 *
 * @module live-config
 */
/** The loader event emitted after volatile references were committed in place. */
export declare const VOLATILE_UPDATE_EVENT = "loader/volatile-update";
/** A stable config reference, as produced by a `volatile()` schema node. */
export interface VolatileRef<T = unknown> {
    /** The immutable snapshot the reference currently holds. */
    get(): T;
}
/**
 * Whether `value` is a volatile config reference.
 *
 * The test is the protocol marker, not the class: the host may have supplied
 * references built by its own copy of cosmokit, and those must be recognised.
 * @param value - a resolved config field.
 * @returns true when the field is a reference rather than a plain value.
 */
export declare function isVolatileRef(value: unknown): value is VolatileRef;
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
export declare function plainConfig<T extends object>(source: T): T;
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
export declare function adoptLiveConfig<T extends object>(target: T, source: T): T;
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
export declare function followVolatileUpdates(ctx: unknown, target: object, source: object): boolean;
