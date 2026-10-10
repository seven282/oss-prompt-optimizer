/**
 * Optional DeepSeek Harness settings integration.
 *
 * **What this module is not (any more).** Up to 0.1.x it registered the plugin's
 * whole Config schema as a `ctx.settings` namespace (`settings.register(ns,
 * schema, { base })`) and re-adopted the resolved value before every run.
 * dsh **0.2.0 removed `SettingsForms.register`** — the service now exposes only
 * `configure/writable/documentPath/prepareDocument/describe/update/replace/
 * mutate` — so that bridge could never resolve a value: it returned `null` on a
 * current host while the client kept reading a service name (`settingsScope`)
 * that no longer exists. That is issue #3: a settings page that said "saved" and
 * wrote nothing.
 *
 * **How editing works now.** The plugin owns its page (a `settings.section` nav
 * entry, see `client/client.js`) and its eight live Config fields are declared
 * `volatile()`, so dsh-settings projects them into a form
 * (`volatileForm()` → `configForms` → `remote.settings.mutate`) and the loader
 * commits an edit **in place** without remounting the plugin (`live-config.ts`).
 *
 * **What is left for the host side.** One thing: tell dsh-settings not to
 * auto-generate a second page for this entry — the official convention for a
 * plugin that ships its own, and it stops two editors from owning one document.
 *
 * The handshake stays fully optional: a deployment without the settings service
 * logs nothing, shows no page, and keeps resolving config from
 * `cordis.patch.yml` alone.
 *
 * @module settings
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
