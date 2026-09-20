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
import { Config } from './config.js';
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
export function createSettingsBridge(ctx, base, apply) {
    const settings = ctx.settings;
    if (settings === undefined || typeof settings.register !== 'function') {
        return null;
    }
    let scope;
    try {
        scope = settings.register('prompt-optimizer', Config, { base });
    }
    catch (err) {
        ctx.logger?.warn?.('prompt-optimizer: settings 命名空间注册失败，跳过设置面板', err);
        return null;
    }
    return {
        sync() {
            const resolved = scope?.get();
            if (resolved !== undefined && resolved !== null && typeof resolved === 'object') {
                apply(resolved);
                return true;
            }
            return false;
        },
        async update(patch) {
            if (scope === undefined)
                return;
            await scope.update(patch);
            // Scope.get() reflects the committed user layer immediately after
            // update settles; re-sync so the service sees the change.
            this.sync();
        },
    };
}
