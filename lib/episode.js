/**
 * Episode logging: lightweight behavior collection for the
 * auto-iteration system. Each optimization call records an Episode
 * with input metadata, cost, quality signals, and acceptance feedback.
 *
 * Pure functions + a bounded circular buffer — no harness dependency,
 * unit-testable standalone. Since 1.8.1 the log is persisted by
 * `persistence.ts` (privacy-cropped, `persistState` on by default);
 * with persistence off it stays in-memory and clears on plugin reload.
 *
 * @module episode
 */
/** Circular buffer of recent episodes (most recent at the end). */
export class EpisodeLog {
    episodes = [];
    maxEntries;
    constructor(maxEntries = 200) {
        this.maxEntries = Math.max(1, maxEntries);
    }
    /** Rebuild a log from persisted (cropped) episodes, oldest→newest. */
    static from(cropped, maxEntries = 200) {
        const log = new EpisodeLog(maxEntries);
        for (const ep of cropped) {
            log.push({ input: '', ...ep });
        }
        return log;
    }
    /** Record a new episode. Evicts the oldest when at capacity. */
    push(episode) {
        this.episodes.push(episode);
        if (this.episodes.length > this.maxEntries) {
            this.episodes.shift();
        }
    }
    /** Return all episodes (copy, safe to mutate). */
    all() {
        return this.episodes.slice();
    }
    /** Return the N most recent episodes. */
    recent(n) {
        return this.episodes.slice(-Math.min(n, this.episodes.length));
    }
    /** Total episodes logged. */
    get size() {
        return this.episodes.length;
    }
    /** Clear all episodes. */
    clear() {
        this.episodes.length = 0;
    }
    /** Find episodes matching a predicate. */
    filter(predicate) {
        return this.episodes.filter(predicate);
    }
    /** Update an episode's quality/accepted fields by index. */
    updateFeedback(index, feedback) {
        const ep = this.episodes[index];
        if (ep === undefined)
            return;
        if (feedback.quality !== undefined)
            ep.quality = feedback.quality;
        if (feedback.accepted !== undefined)
            ep.accepted = feedback.accepted;
    }
}
/** Maximum input characters stored per episode (to avoid unbounded memory). */
export const EPISODE_INPUT_MAX_CHARS = 200;
/** Truncate input for episode storage. */
export function truncateEpisodeInput(input) {
    if (input.length <= EPISODE_INPUT_MAX_CHARS)
        return input;
    return input.slice(0, EPISODE_INPUT_MAX_CHARS) + '…';
}
