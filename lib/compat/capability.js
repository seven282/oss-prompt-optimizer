/**
 * Runtime capability probing.
 *
 * The plugin deliberately does **not** gate on the harness version number — a
 * bump does not imply a contract change and a patch release can move an export
 * (the 1.8.1 `deepFreeze` incident was exactly that). It probes whether the
 * functions it actually calls are present and of the expected kind instead.
 *
 * Host types are always imported with a top-level `import type …`: under
 * `verbatimModuleSyntax` the inline `import { type X }` form survives as
 * `import {} from '…'`, which still fetches the host module at instantiation.
 * P1 fails the build if that regresses.
 * @module compat/capability
 * @see docs/compatibility.md §2
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
