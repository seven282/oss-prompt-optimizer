import type { FinishReason } from '@deepseek-ai/dsh-llm';
import type { StreamAssembler } from './compat/capability.js';
import { OptimizeError } from './errors.js';
/**
 * Raised when a model call stops because the output hit `maxTokens`.
 * `partial` carries the text assembled before truncation — the resume
 * (断点续传) path appends it to the accumulated output and asks the next
 * call to continue from there. Re-exported from `./optimizer.js` (and
 * `index.js`) to keep the public API surface unchanged.
 */
export declare class MaxTokensError extends OptimizeError {
    /** The text produced before the `max-tokens` finish (empty when none). */
    readonly partial: string;
    constructor(partial?: string);
}
/** Translate a terminal finish reason into a thrown error, or accept `stop`. Pure function. */
export declare function finishToError(finish: FinishReason): Error | undefined;
/**
 * Concatenate the text blocks of a finished stream assembler. Pure function.
 *
 * Takes the structural {@link StreamAssembler} rather than the host's
 * `BlockAssembler` type: the assembler is resolved at runtime by the compat
 * loader (1.8.2), and a real host `BlockAssembler` satisfies this interface
 * unchanged.
 */
export declare function assembleStream(assembler: StreamAssembler): string;
/**
 * Extended MaxTokensError that carries the partial output for resume (断点续传).
 * Created by optimizer.ts when handling max-tokens truncation, allowing safe
 * attachment of partial data without unsafe type assertions.
 */
export declare class MaxTokensErrorWithPartial extends MaxTokensError {
    constructor(partial: string, original: MaxTokensError);
}
