/**
 * Optional DeepSeek Harness settings integration — the host side only.
 *
 * Up to 0.1.x this registered the whole Config schema as a `ctx.settings`
 * namespace and re-adopted the resolved value before every run. dsh 0.2.0 dropped
 * `SettingsForms.register`, so that bridge could never resolve a value while the
 * client kept reading the gone name `settingsScope` — issue #3.
 * Now the plugin owns its page (`settings.section`), its eight live fields are
 * `volatile()`, and all that remains here is one call telling dsh-settings not to
 * auto-generate a second page. Without the service nothing is logged, no page
 * appears, and config resolves from `cordis.patch.yml` alone.
 *
 * @module settings
 * @see docs/compatibility.md §5, §7
 */
import { scopedInject } from './compat/scope.js';
/**
 * Register this plugin's settings-page policy with the host, when there is one.
 *
 * Never throws and never blocks: the service is reached through `scopedInject`,
 * which calls back only once `settings` is actually available, and every step
 * inside is guarded. The returned handle is mutated in place, so the caller can
 * hold it from construction time and observe `active` turning true later.
 *
 * @param ctx - the plugin's context (the caller's fiber becomes the page owner).
 * @returns the handle; `active` stays false on a host without dsh-settings.
 */
export function configureSettingsPage(ctx) {
    // `settings` may only appear after this call returns (that is the whole point
    // of `scopedInject`), so the flag lives outside the exposed object and the
    // handle reads it through a getter.
    let active = false;
    const handle = {
        get active() {
            return active;
        },
    };
    scopedInject(ctx, ['settings'], (scoped) => {
        const settings = scoped.settings;
        if (settings === undefined || typeof settings.configure !== 'function')
            return;
        const fiber = ctx.fiber;
        let dispose;
        try {
            dispose = settings.configure({ auto: false }, fiber);
        }
        catch (err) {
            // A second policy for the same fiber throws — that is a host-side fact,
            // not a reason to lose the rest of the plugin.
            ctx.logger?.warn?.('prompt-optimizer: settings 页面策略注册失败，宿主自动页保持原样', err);
            return;
        }
        active = true;
        // Tie the policy to this plugin's lifetime. `effect` returned by `inject`
        // exists on every supported host; the guard keeps an odd context from
        // turning hygiene into a crash.
        const effect = scoped.effect;
        if (typeof dispose === 'function' && typeof effect === 'function') {
            try {
                ;
                effect.call(scoped, () => dispose);
            }
            catch { /* best effort */ }
        }
    });
    return handle;
}
