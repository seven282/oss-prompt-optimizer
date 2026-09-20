/**
 * Runtime capability probing.
 *
 * The plugin deliberately does **not** gate on the harness version number:
 * a version bump does not mean a contract changed, and a patch release can
 * move an export (the 1.8.1 `deepFreeze` incident was exactly that). What
 * matters is whether the functions the plugin actually calls are *present and
 * of the expected kind*, so that is what gets probed.
 *
 * Every probe goes through {@link resolveExport}, which can only return `null`
 * — never throw — so this module is safe to call during plugin construction on
 * any host.
 *
 * Types are still imported from the host packages, but always with a top-level
 * `import type …`, never the inline `import { type X }` form: under
 * `verbatimModuleSyntax` the inline form is preserved as `import {} from '…'`,
 * which is still a *runtime* import and would fetch the host module during
 * instantiation — reintroducing the exact uncatchable failure this layer exists
 * to remove. `scripts/preflight.mjs` P1 fails the build if that ever regresses.
 *
 * @module compat/capability
 */
import { resolveConstructor, resolveExport } from './loader.js';
/** Package + export names, kept in one place so tests can assert on them. */
export const CAPABILITY_SOURCES = {
    defineTool: ['@deepseek-ai/dsh-tools', 'defineTool'],
    createUserMessage: ['@deepseek-ai/dsh-llm', 'createUserMessage'],
    BlockAssembler: ['@deepseek-ai/dsh-llm', 'BlockAssembler'],
};
/**
 * Resolve every host capability once. Missing entries come back as `null`;
 * the caller decides what to disable (see {@link DEGRADATION_NOTES}).
 */
export function probeCapabilities() {
    const [toolsPkg, defineToolName] = CAPABILITY_SOURCES.defineTool;
    const [llmPkg, createUserMessageName] = CAPABILITY_SOURCES.createUserMessage;
    const [assemblerPkg, assemblerName] = CAPABILITY_SOURCES.BlockAssembler;
    return {
        defineTool: resolveExport(toolsPkg, defineToolName, 'function'),
        createUserMessage: resolveExport(llmPkg, createUserMessageName, 'function'),
        BlockAssembler: resolveConstructor(assemblerPkg, assemblerName),
    };
}
/** One-line status per capability, e.g. `defineTool=ok BlockAssembler=MISSING`. */
export function formatCapabilitySummary(caps) {
    return [
        `defineTool=${caps.defineTool === null ? 'MISSING' : 'ok'}`,
        `createUserMessage=${caps.createUserMessage === null ? 'MISSING' : 'ok'}`,
        `BlockAssembler=${caps.BlockAssembler === null ? 'MISSING' : 'ok'}`,
    ].join(' ');
}
/** Static truth table: missing capability → disabled feature → surviving surface. */
export const DEGRADATION_NOTES = [
    {
        capability: 'defineTool',
        feature: 'the `prompt_optimize` tool is not registered',
        stillWorks: 'the `/optimize` command and the input-box button still work',
    },
    {
        capability: 'createUserMessage',
        feature: 'autoOptimize prefix replacement is disabled',
        stillWorks: 'manual optimization, commands and the input-box button still work',
    },
    {
        capability: 'BlockAssembler',
        feature: 'streamed optimization cannot be assembled',
        stillWorks: 'nothing — `/optimize` reports UNSUPPORTED_ENV instead of failing silently',
    },
];
/** Degradations implied by `caps`, in {@link DEGRADATION_NOTES} order. */
export function describeDegradations(caps) {
    return DEGRADATION_NOTES.filter((note) => caps[note.capability] === null);
}
/**
 * Single startup log line. Always emitted once, so a degraded start is
 * discoverable instead of silent (degradation is otherwise invisible).
 */
export function formatCompatReport(caps) {
    const summary = formatCapabilitySummary(caps);
    const degraded = describeDegradations(caps);
    if (degraded.length === 0) {
        return `prompt-optimizer: host compat ok (${summary})`;
    }
    const details = degraded.map((d) => `${d.capability}: ${d.feature}; ${d.stillWorks}`).join(' | ');
    return `prompt-optimizer: host compat DEGRADED (${summary}) — ${details}`;
}
