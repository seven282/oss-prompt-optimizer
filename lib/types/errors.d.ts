/**
 * Machine-readable error codes for the prompt-optimizer capability. Every
 * failure path — the loud `OptimizeError` throws and the graceful
 * `OptimizeResult.errorCode` fallback field — shares this vocabulary so
 * callers (commands, tools, other plugins) can react programmatically
 * instead of matching on message text.
 */
/** Stable, typed error-code vocabulary. */
export declare const OptimizeErrorCode: {
    /** The instruction was empty or not a string. */
    readonly EMPTY_INPUT: "EMPTY_INPUT";
    /** No model route could be resolved (incomplete config pair / no default model). */
    readonly NO_MODEL_ROUTE: "NO_MODEL_ROUTE";
    /** The per-call deadline elapsed before the model call finished. */
    readonly TIMEOUT: "TIMEOUT";
    /** The model output hit `maxTokens`. */
    readonly MAX_TOKENS: "MAX_TOKENS";
    /** The unified call budget (`maxCalls`) was exhausted. */
    readonly TOO_MANY_CALLS: "TOO_MANY_CALLS";
    /**
     * The cumulative token budget of one optimization (`maxTotalTokens`,
     * 1.6.8 D1) ran out — expansion jumps and validation retries stop and the
     * best result so far degrades as usual.
     */
    readonly BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
    /** The output was missing one or more required sections. */
    readonly MISSING_SECTIONS: "MISSING_SECTIONS";
    /** A section body was shorter than `minSectionChars`. */
    readonly THIN_SECTIONS: "THIN_SECTIONS";
    /** A plain-style output was shorter than `minSectionChars`. */
    readonly THIN_OUTPUT: "THIN_OUTPUT";
    /** A plain-style output still carried four-section headings. */
    readonly HEADINGS_IN_PLAIN: "HEADINGS_IN_PLAIN";
    /** The output dropped the instruction's goal or a constraint (situation alignment). */
    readonly GOAL_MISALIGNED: "GOAL_MISALIGNED";
    /**
     * The output carried meta/methodology content (optimization criteria,
     * "core constraint logic", a summary section) instead of only the
     * optimized prompt itself (1.6.3 purity gate).
     */
    readonly META_CONTENT: "META_CONTENT";
    /** The model unexpectedly requested a tool call. */
    readonly TOOL_CALL: "TOOL_CALL";
    /** The model returned an unrecognized finish reason. */
    readonly UNSUPPORTED_FINISH: "UNSUPPORTED_FINISH";
    /** The model produced no text at all. */
    readonly NO_TEXT: "NO_TEXT";
    /**
     * The host does not expose a capability this operation needs (1.8.2). The
     * plugin probes host packages at startup instead of importing them
     * statically, so a harness upgrade that drops an export disables one
     * feature — and says so — rather than taking the process down.
     */
    readonly UNSUPPORTED_ENV: "UNSUPPORTED_ENV";
    /** Any other failure not covered above. */
    readonly UNKNOWN: "UNKNOWN";
};
/** Union of all stable error codes. */
export type OptimizeErrorCode = (typeof OptimizeErrorCode)[keyof typeof OptimizeErrorCode];
/** An error carrying a stable machine-readable code. */
export declare class OptimizeError extends Error {
    readonly code: OptimizeErrorCode;
    constructor(code: OptimizeErrorCode, message: string, options?: ErrorOptions);
}
/** Command-facing Chinese text per error code (stable, caller-rendered). */
export declare const OPTIMIZE_ERROR_TEXT: Record<OptimizeErrorCode, string>;
/** Stable failure message when a plain-style output was shorter than `minSectionChars`. */
export declare function thinOutputMessage(minChars: number): string;
/** Stable failure message when a plain-style output carries section headings. */
export declare function plainHeadingsMessage(): string;
/** Stable failure message when the output carries meta/methodology content. */
export declare function metaContentMessage(): string;
/** Stable failure message when the model omits one or more sections. */
export declare const INCOMPLETE_SECTIONS_MESSAGE = "optimized prompt is missing one or more required sections (## Role / ## Task / ## Context / ## Format)";
/** Stable failure message when a section body is empty or too short. */
export declare function thinSectionsMessage(minChars: number): string;
