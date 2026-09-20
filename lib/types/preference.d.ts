/**
 * User preference model: aggregates episode data into actionable statistics
 * for the adaptation engine. Pure functions over episode history — no harness
 * dependency, unit-testable standalone.
 *
 * Computes: subtype/task-type frequency, quality trends, local acceptance
 * rate, edit rate, and token consumption trends. All time-windowed to the
 * most recent N episodes for recency bias.
 *
 * @module preference
 */
import type { EpisodeLog } from './episode.js';
import type { TaskType } from './meta.js';
/** Aggregated preference statistics. */
export interface PreferenceModel {
    /** Total episodes analyzed. */
    total: number;
    /** Task-type frequency (e.g. { writing: 15, code: 10 }). */
    taskTypeFreq: Map<TaskType, number>;
    /** Subtype frequency (e.g. { 'writing-report': 12, 'code-bugfix': 8 }). */
    subtypeFreq: Map<string, number>;
    /** Dominant task type (most frequent). */
    dominantTaskType?: TaskType;
    /** Dominant subtype (most frequent). */
    dominantSubtype?: string;
    /** Local template acceptance rate (episodes where local=true and accepted=true / total local). */
    localAcceptanceRate: number;
    /** Local template usage rate (episodes where local=true / total). */
    localUsageRate: number;
    /** Quality trend: rolling average quality over time (windowed). */
    qualityTrend: number[];
    /** Average quality score across episodes with feedback. */
    avgQuality: number;
    /** Edit rate: fraction of episodes where accepted=false (user edited/rejected). */
    editRate: number;
    /** Average output tokens per episode. */
    avgOutputTokens: number;
    /** Average input tokens per episode. */
    avgInputTokens: number;
    /** Average duration (ms) per episode. */
    avgDurationMs: number;
    /** Profile usage distribution (e.g. { fast: 12, balanced: 8 }). */
    profileFreq: Map<string, number>;
    /** Episodes with quality feedback count. */
    feedbackCount: number;
}
/** Compute preference model from episode log (windowed to last N episodes). */
export declare function computePreferences(log: EpisodeLog, windowSize?: number): PreferenceModel;
/** Format preference model as human-readable text (for /optimize --insights). */
export declare function formatPreferences(prefs: PreferenceModel, lang?: 'zh' | 'en'): string;
