/**
 * Host feedback signals (1.12.0).
 *
 * The plugin had been guessing at acceptance: `episodes[].accepted` came from the
 * ✨ accept/undo buttons, so a user who simply typed a follow-up — the strongest
 * possible "this was wrong" signal — was recorded as neither. The host keeps the
 * real judgment on disk (`messageFeedback`), read back through the
 * `messageFeedback.list` Remote and reduced here to counts. The read is duck-typed,
 * so a renamed service degrades to "no signals" rather than failing the load.
 * Privacy: this module NEVER copies an item's free-text `note`, only its rating,
 * category slug and whether a note existed — nothing reaches the state file, an
 * event, a command output or a log line. Feedback judges a past ANSWER, not the
 * prompt, so a mostly-negative session only biases sampling diversity next run.
 * @module feedback
 */
/** One host feedback item, duck-typed to the fields this module consumes. */
export interface HostFeedbackItem {
    readonly messageId?: unknown;
    readonly rating?: unknown;
    readonly category?: unknown;
    readonly note?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
}
/** The `messageFeedback` slice of the host context this module talks to. */
export interface MessageFeedbackLike {
    list(request: {
        sessionId: string;
    }): Promise<unknown>;
}
/** The two ratings the host vocabulary defines. */
export type FeedbackRating = 'positive' | 'negative';
/** Aggregated feedback counts for one session (no text, ever). */
export interface FeedbackLedger {
    /** Session the counts belong to. */
    sessionId: string;
    /** Items seen, per rating. */
    positive: number;
    negative: number;
    /** Items that carried a note (the note text itself is never stored). */
    withNote: number;
    /** Feedback items per category slug (closed vocabulary from the host). */
    categories: Record<string, number>;
    /** Timestamp (ms) of the most recent item seen, if the host reported one. */
    latestTs?: number;
    /** When this ledger was last refreshed (ms). */
    fetchedAt: number;
}
/** Host feedback cache lifetime: refreshes are rate-limited per session. */
export declare const FEEDBACK_TTL_MS = 60000;
/** Cap on distinct sessions tracked (bounded memory for a long-lived host). */
export declare const FEEDBACK_MAX_SESSIONS = 32;
/**
 * Optional bias applied to the sampling temperature from host feedback. A
 * negative-heavy session explores more (a fresh draw is the cheapest way out of
 * "the last few answers were wrong"); a positive-heavy one exploits what is
 * already working. Bounded to ±`FEEDBACK_TEMPERATURE_STEP` so feedback can
 * never move the temperature anywhere near the top of the range on its own.
 */
export declare const FEEDBACK_TEMPERATURE_STEP = 0.1;
/** Minimum judgments before the bias engages (a single click is not a trend). */
export declare const FEEDBACK_MIN_ITEMS = 3;
/** Share of negative ratings above/below which the bias engages. */
export declare const FEEDBACK_NEGATIVE_HIGH = 0.5;
export declare const FEEDBACK_NEGATIVE_LOW = 0.2;
/** A zeroed ledger for one session. */
export declare function emptyLedger(sessionId: string, now?: number): FeedbackLedger;
/** Whether a session's ledger is old enough to refresh. */
export declare function isStale(ledger: FeedbackLedger | undefined, now?: number, ttlMs?: number): boolean;
/**
 * Coerce one host item. Returns `undefined` for anything that does not carry a
 * recognized rating — an unknown shape is dropped rather than counted as a
 * category of its own, so a host vocabulary change cannot silently invent
 * signal.
 */
export declare function normalizeItem(raw: unknown): {
    rating: FeedbackRating;
    category?: string;
    withNote: boolean;
    ts?: number;
} | undefined;
/**
 * Extract the item array out of whatever the Remote returned. The host answers
 * `{ ok: true, value: { items } }`; a deployment that wraps it differently (or
 * an older host that returns the array directly) still yields items, and a
 * definite miss (`ok: false`, i.e. no such session) yields `undefined` so the
 * caller can distinguish "no feedback" from "could not read".
 */
export declare function feedbackItems(result: unknown): readonly unknown[] | undefined;
/**
 * Fold host items into a ledger. Counts REPLACE the previous values rather
 * than accumulating: the host list is the current truth for that session, so
 * re-reading it twice must not double every count.
 */
export declare function mergeItems(sessionId: string, items: readonly unknown[] | undefined, now?: number): FeedbackLedger;
/** Total judged items in one ledger. */
export declare function ledgerTotal(ledger: FeedbackLedger): number;
/** Share of negative judgments (0 when nothing was judged). */
export declare function negativeRate(ledger: FeedbackLedger): number;
/**
 * The temperature bias implied by one ledger: `+step` when negatives dominate,
 * `-step` when they are rare, `0` when the sample is too small or the mix is
 * middling. Returns both the value and the reason, so the caller can report
 * WHY the temperature moved instead of presenting a number with no story.
 */
export declare function feedbackBias(ledger: FeedbackLedger | undefined, enabled?: boolean, step?: number): {
    delta: number;
    reason?: string;
};
/** Apply a bias to a base temperature, clamped to the harness's 0–2 range. */
export declare function applyBias(temperature: number, delta: number, min?: number, max?: number): number;
/**
 * Format the ledger readback for `/optimize --feedback`. Counts and category
 * slugs only — there is no field in the ledger this function could leak.
 */
export declare function formatFeedback(ledgers: readonly FeedbackLedger[], lang?: 'zh' | 'en', serviceAvailable?: boolean): string;
/** Machine-readable token for `/optimize --feedback` (numbers only). */
export declare function feedbackToken(ledgers: readonly FeedbackLedger[], bias: number): string;
