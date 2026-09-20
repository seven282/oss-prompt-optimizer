/**
 * Optional DeepSeek Harness settings integration (P0, 1.7.8).
 *
 * Registers the plugin's config schema as a `ctx.settings` namespace so the
 * Harness settings panel renders every option (45+ fields) with defaults,
 * live values and user overrides — no hand-written settings page needed.
 *
 * Resolution (dsh-settings): schema defaults → `base` (this plugin's
 * entry-config snapshot) → user document (edited in the settings panel).
 * `scope.get()` therefore returns the FINAL configuration; the service
 * adopts it by shallow-assigning onto its own config object.
 *
 * The bridge is fully optional: when `ctx.settings` is not mounted (or
 * registration fails), it returns null and the plugin keeps resolving its
 * entry config alone — zero behavioural change in settings-less hosts.
 *
 * @module settings
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config as ConfigType } from './config.js';
/** Bridge handle consumed by the optimizer service. */
export interface SettingsBridge {
    /** Re-adopt the resolved configuration into the service config. */
    sync(): boolean;
    /** Persist a user-layer patch (e.g. runtime command overrides). */
    update(patch: Partial<ConfigType>): Promise<void>;
}
/**
 * Lazily create the settings bridge.
 *
 * `base` is the plugin's current entry-config snapshot (from cordis.yml /
 * cordis.patch.yml); the user document layered on top becomes the effective
 * config. `apply` receives the fully resolved value so the service can adopt
 * it without chasing individual keys.
 *
 * Returns null when settings is unavailable or registration fails — callers
 * must treat null as "keep entry config only".
 */
export declare function createSettingsBridge(ctx: Context, base: Partial<ConfigType>, apply: (resolved: Partial<ConfigType>) => void): SettingsBridge | null;
