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
import type { Context } from '@deepseek-ai/cordis';
/** Handle for the optional settings handshake, consumed by the service. */
export interface SettingsPage {
    /** True once a live settings service accepted the page policy. */
    readonly active: boolean;
}
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
export declare function configureSettingsPage(ctx: Context): SettingsPage;
