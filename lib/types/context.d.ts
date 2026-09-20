/** Minimum shape of a conversation message the gatherer can read. */
export interface ContextMessage {
    /**
     * Text blocks (the `content` of `UserMessage` / dsh-session `Message`) or a
     * plain text string (defensive: some surfaces hand over already-rendered
     * text). Only `{ type: 'text' }` blocks are read; tool results and other
     * block kinds are skipped.
     */
    content: readonly {
        type: string;
        text?: string;
    }[] | string;
}
/** Concatenated text of one message's text blocks (or the raw string). */
export declare function contextMessageText(message: ContextMessage): string;
/** Options for {@link gatherConversationContext}. */
export interface GatherContextOptions {
    /** Maximum number of recent messages to include; `<= 0` returns no context. */
    maxMessages: number;
    /**
     * Token budget for the joined context; `<= 0` disables the token guard.
     * Truncation keeps the longest prefix within budget and appends a marker.
     */
    maxTokens: number;
    /** Token estimator (harness `tokenMeter` or the heuristic default). */
    estimate?: (text: string) => number;
}
/**
 * Gather the recent conversation context from a message list: take the last
 * `maxMessages` messages, keep only their non-empty text, join them, and
 * bound the result by the token budget. Returns `''` when there is nothing
 * to use (empty list, all empty texts, or `maxMessages <= 0`).
 */
export declare function gatherConversationContext(messages: readonly ContextMessage[], options: GatherContextOptions): string;
/**
 * Wrap gathered context in the language-dependent guardrail block. Returns
 * `''` for empty input so the placeholder renders away cleanly. The guardrail
 * mirrors the meta-prompt's instruction-is-data rule: context is background
 * reference only — never to be executed, repeated, or leaked. In the
 * `'sections'` output style an extra rule tells the optimizer it MAY use the
 * context's facts to enrich the output's `## Context` section (方案 A) — this
 * is what makes the four-section result actually reflect the conversation.
 */
export declare function buildContextBlock(context: string, metaLanguage: 'zh' | 'en', outputStyle?: 'sections' | 'plain' | 'role-task-goal'): string;
