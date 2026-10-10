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
/** Host feedback cache lifetime: refreshes are rate-limited per session. */
export const FEEDBACK_TTL_MS = 60_000;
/** Cap on distinct sessions tracked (bounded memory for a long-lived host). */
export const FEEDBACK_MAX_SESSIONS = 32;
/**
 * Optional bias applied to the sampling temperature from host feedback. A
 * negative-heavy session explores more (a fresh draw is the cheapest way out of
 * "the last few answers were wrong"); a positive-heavy one exploits what is
 * already working. Bounded to ±`FEEDBACK_TEMPERATURE_STEP` so feedback can
 * never move the temperature anywhere near the top of the range on its own.
 */
export const FEEDBACK_TEMPERATURE_STEP = 0.1;
/** Minimum judgments before the bias engages (a single click is not a trend). */
export const FEEDBACK_MIN_ITEMS = 3;
/** Share of negative ratings above/below which the bias engages. */
export const FEEDBACK_NEGATIVE_HIGH = 0.5;
export const FEEDBACK_NEGATIVE_LOW = 0.2;
/** A zeroed ledger for one session. */
export function emptyLedger(sessionId, now = Date.now()) {
    return { sessionId, positive: 0, negative: 0, withNote: 0, categories: {}, fetchedAt: now };
}
/** Whether a session's ledger is old enough to refresh. */
export function isStale(ledger, now = Date.now(), ttlMs = FEEDBACK_TTL_MS) {
    if (ledger === undefined)
        return true;
    return now - ledger.fetchedAt >= ttlMs;
}
/**
 * Coerce one host item. Returns `undefined` for anything that does not carry a
 * recognized rating — an unknown shape is dropped rather than counted as a
 * category of its own, so a host vocabulary change cannot silently invent
 * signal.
 */
export function normalizeItem(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const item = raw;
    const rating = item.rating === 'positive' || item.rating === 'negative' ? item.rating : undefined;
    if (rating === undefined)
        return undefined;
    const category = typeof item.category === 'string' && item.category.length > 0 ? item.category : undefined;
    const withNote = typeof item.note === 'string' && item.note.trim().length > 0;
    const ts = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : undefined;
    return { rating, ...(category !== undefined ? { category } : {}), withNote, ...(ts !== undefined ? { ts } : {}) };
}
/**
 * Extract the item array out of whatever the Remote returned. The host answers
 * `{ ok: true, value: { items } }`; a deployment that wraps it differently (or
 * an older host that returns the array directly) still yields items, and a
 * definite miss (`ok: false`, i.e. no such session) yields `undefined` so the
 * caller can distinguish "no feedback" from "could not read".
 */
export function feedbackItems(result) {
    if (Array.isArray(result))
        return result;
    if (result === null || typeof result !== 'object')
        return undefined;
    const envelope = result;
    if (envelope.ok === false)
        return undefined;
    const value = envelope.value ?? result;
    if (Array.isArray(value))
        return value;
    if (value !== null && typeof value === 'object') {
        const items = value.items;
        if (Array.isArray(items))
            return items;
    }
    return undefined;
}
/**
 * Fold host items into a ledger. Counts REPLACE the previous values rather
 * than accumulating: the host list is the current truth for that session, so
 * re-reading it twice must not double every count.
 */
export function mergeItems(sessionId, items, now = Date.now()) {
    const ledger = emptyLedger(sessionId, now);
    for (const raw of items ?? []) {
        const item = normalizeItem(raw);
        if (item === undefined)
            continue;
        if (item.rating === 'positive')
            ledger.positive++;
        else
            ledger.negative++;
        if (item.withNote)
            ledger.withNote++;
        if (item.category !== undefined)
            ledger.categories[item.category] = (ledger.categories[item.category] ?? 0) + 1;
        if (item.ts !== undefined && (ledger.latestTs === undefined || item.ts > ledger.latestTs))
            ledger.latestTs = item.ts;
    }
    return ledger;
}
/** Total judged items in one ledger. */
export function ledgerTotal(ledger) {
    return ledger.positive + ledger.negative;
}
/** Share of negative judgments (0 when nothing was judged). */
export function negativeRate(ledger) {
    const total = ledgerTotal(ledger);
    return total > 0 ? ledger.negative / total : 0;
}
/**
 * The temperature bias implied by one ledger: `+step` when negatives dominate,
 * `-step` when they are rare, `0` when the sample is too small or the mix is
 * middling. Returns both the value and the reason, so the caller can report
 * WHY the temperature moved instead of presenting a number with no story.
 */
export function feedbackBias(ledger, enabled = true, step = FEEDBACK_TEMPERATURE_STEP) {
    if (!enabled || ledger === undefined)
        return { delta: 0 };
    const total = ledgerTotal(ledger);
    if (total < FEEDBACK_MIN_ITEMS)
        return { delta: 0 };
    const rate = negativeRate(ledger);
    if (rate >= FEEDBACK_NEGATIVE_HIGH) {
        return { delta: step, reason: `host feedback ${ledger.negative}/${total} negative → more sampling diversity` };
    }
    if (rate <= FEEDBACK_NEGATIVE_LOW) {
        return { delta: -step, reason: `host feedback ${ledger.negative}/${total} negative → less sampling diversity` };
    }
    return { delta: 0 };
}
/** Apply a bias to a base temperature, clamped to the harness's 0–2 range. */
export function applyBias(temperature, delta, min = 0, max = 2) {
    if (delta === 0)
        return temperature;
    return Math.min(max, Math.max(min, Math.round((temperature + delta) * 1000) / 1000));
}
/**
 * Format the ledger readback for `/optimize --feedback`. Counts and category
 * slugs only — there is no field in the ledger this function could leak.
 */
export function formatFeedback(ledgers, lang = 'zh', serviceAvailable = true) {
    const lines = [];
    if (!serviceAvailable) {
        return lang === 'zh'
            ? '宿主未提供 messageFeedback 服务——本插件不做任何宿主反馈读取（不影响其他功能）。'
            : 'Host exposes no messageFeedback service — no host feedback is read (nothing else is affected).';
    }
    const active = ledgers.filter((ledger) => ledgerTotal(ledger) > 0 || Object.keys(ledger.categories).length > 0);
    if (active.length === 0) {
        return lang === 'zh'
            ? '暂无宿主反馈记录（在消息下点赞/点踩后，此处会出现按会话统计的计数）。'
            : 'No host feedback recorded yet (rate a message and per-session counts appear here).';
    }
    for (const ledger of active) {
        const total = ledgerTotal(ledger);
        const rate = Math.round(negativeRate(ledger) * 100);
        const when = new Date(ledger.fetchedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false });
        if (lang === 'zh') {
            lines.push(`  会话 ${ledger.sessionId.slice(0, 8)}…：👍 ${ledger.positive} / 👎 ${ledger.negative}${total > 0 ? `（负面 ${rate}%）` : ''}${ledger.withNote > 0 ? ` ｜ 含备注 ${ledger.withNote}` : ''}`);
            const categories = Object.entries(ledger.categories);
            if (categories.length > 0)
                lines.push(`    分类: ${categories.map(([key, count]) => `${key}×${count}`).join(' ')}`);
            lines.push(`    读取于 ${when}（仅计数——备注原文永不落盘）`);
        }
        else {
            lines.push(`  Session ${ledger.sessionId.slice(0, 8)}…: 👍 ${ledger.positive} / 👎 ${ledger.negative}${total > 0 ? ` (${rate}% negative)` : ''}${ledger.withNote > 0 ? ` ｜ ${ledger.withNote} with note` : ''}`);
            const categories = Object.entries(ledger.categories);
            if (categories.length > 0)
                lines.push(`    Categories: ${categories.map(([key, count]) => `${key}×${count}`).join(' ')}`);
            lines.push(`    Read at ${when} (counts only — note text never touches disk)`);
        }
    }
    return lines.join('\n');
}
/** Machine-readable token for `/optimize --feedback` (numbers only). */
export function feedbackToken(ledgers, bias) {
    const positive = ledgers.reduce((sum, ledger) => sum + ledger.positive, 0);
    const negative = ledgers.reduce((sum, ledger) => sum + ledger.negative, 0);
    const sessions = ledgers.filter((ledger) => ledgerTotal(ledger) > 0).length;
    return `FEEDBACK:SESSIONS:${sessions}|POSITIVE:${positive}|NEGATIVE:${negative}|BIAS:${bias}`;
}
