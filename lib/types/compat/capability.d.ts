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
import type { createUserMessage, ContentBlock, FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { defineTool } from '@deepseek-ai/dsh-tools';
/** The host function used to declare a tool. */
export type DefineToolFn = typeof defineTool;
/** The host function used to build a user message block. */
export type CreateUserMessageFn = typeof createUserMessage;
/**
 * Structural view of `@deepseek-ai/dsh-llm`'s `BlockAssembler` — only the
 * members this plugin calls. Kept structural (rather than importing the class
 * type) so the assembler can be produced by the loader; the host class
 * satisfies it as-is, which keeps the existing tests passing a real
 * `BlockAssembler` unchanged.
 */
export interface StreamAssembler {
    /** Feed one raw chunk, in stream order. */
    push(chunk: StreamChunk): void;
    /** All blocks assembled so far. */
    blocks(): ContentBlock[];
    /** Terminal finish reason (`{ kind: 'stop' }` when the stream ended without one). */
    readonly finish: FinishReason;
}
/** Constructor of a {@link StreamAssembler}. */
export type StreamAssemblerCtor = new () => StreamAssembler;
/** Host capabilities the plugin needs, each independently optional. */
export interface Capabilities {
    /** `defineTool` from `@deepseek-ai/dsh-tools`. */
    readonly defineTool: DefineToolFn | null;
    /** `createUserMessage` from `@deepseek-ai/dsh-llm`. */
    readonly createUserMessage: CreateUserMessageFn | null;
    /** `BlockAssembler` constructor from `@deepseek-ai/dsh-llm`. */
    readonly BlockAssembler: StreamAssemblerCtor | null;
}
/** Package + export names, kept in one place so tests can assert on them. */
export declare const CAPABILITY_SOURCES: {
    readonly defineTool: readonly ["@deepseek-ai/dsh-tools", "defineTool"];
    readonly createUserMessage: readonly ["@deepseek-ai/dsh-llm", "createUserMessage"];
    readonly BlockAssembler: readonly ["@deepseek-ai/dsh-llm", "BlockAssembler"];
};
/**
 * Resolve every host capability once. Missing entries come back as `null`;
 * the caller decides what to disable (see {@link DEGRADATION_NOTES}).
 */
export declare function probeCapabilities(): Capabilities;
/** One-line status per capability, e.g. `defineTool=ok BlockAssembler=MISSING`. */
export declare function formatCapabilitySummary(caps: Capabilities): string;
/** Feature that a missing capability switches off. */
export interface Degradation {
    /** Capability key that is absent. */
    readonly capability: keyof Capabilities;
    /** Feature that stops working. */
    readonly feature: string;
    /** What still works, so the log line is actionable rather than alarming. */
    readonly stillWorks: string;
}
/** Static truth table: missing capability → disabled feature → surviving surface. */
export declare const DEGRADATION_NOTES: readonly Degradation[];
/** Degradations implied by `caps`, in {@link DEGRADATION_NOTES} order. */
export declare function describeDegradations(caps: Capabilities): Degradation[];
/**
 * Single startup log line. Always emitted once, so a degraded start is
 * discoverable instead of silent (degradation is otherwise invisible).
 */
export declare function formatCompatReport(caps: Capabilities): string;
