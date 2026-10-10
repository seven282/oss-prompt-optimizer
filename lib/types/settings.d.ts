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
