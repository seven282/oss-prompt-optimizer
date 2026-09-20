/**
 * Runtime status formatting (P1, 1.7.9).
 *
 * Aggregates the optimizer's live state into one human-readable status block:
 * effective parameters (with the resolution source), run statistics, usage
 * preference summary, and the most recent optimization events. Served via
 * `/optimize --status` (and the ✨-adjacent status button in client.js).
 *
 * Pure formatting over the service's snapshot — no harness dependency.
 *
 * @module status
 */
import type { PreferenceModel } from './preference.js';
import type { OptimizeStats } from './optimizer.js';
/** One recorded optimization event (success or failure). */
export interface StatusEvent {
    ts: number;
    method: string;
    ok: boolean;
    errorCode?: string;
    outputTokens?: number;
    durationMs?: number;
    local?: boolean;
}
/** Maximum buffered events (FIFO). */
export declare const STATUS_EVENT_MAX = 20;
/** Snapshot handed to the formatter. */
export interface StatusSnapshot {
    effective: {
        profile: 'balanced' | 'fast';
        localTemplate: 'on' | 'off' | 'hybrid';
        temperature: number;
        source: string;
    };
    stats: OptimizeStats;
    prefs: PreferenceModel;
    recentEvents: readonly StatusEvent[];
    autoAdapt: boolean;
    minAdaptEpisodes: number;
    settingsPanel: boolean;
}
/** Format the full status block. */
export declare function formatStatus(snapshot: StatusSnapshot, lang?: 'zh' | 'en'): string;
