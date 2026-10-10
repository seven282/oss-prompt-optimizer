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
export declare const STATUS_MAX_EVENTS = 20;
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
    /**
     * Evaluation harness summary (1.11.0). Optional: a host that never ran
     * `/optimize-eval` renders exactly as before, and a caller that builds a
     * snapshot by hand does not have to fabricate one.
     */
    evalSummary?: {
        /** Runs kept in the history. */
        runs: number;
        /** Latest aggregate (0–1), absent when the last run scored nothing. */
        aggregate?: number;
        /** Baseline aggregate (0–1), absent when none is recorded. */
        baseline?: number;
        /** Verdict of the latest comparison (`pass` | `regress` | …). */
        verdict?: string;
        /** Timestamp of the latest run. */
        at: number;
    };
}
/** Format the full status block. */
export declare function formatStatus(snapshot: StatusSnapshot, lang?: 'zh' | 'en'): string;
