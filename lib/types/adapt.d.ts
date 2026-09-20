/**
 * Adaptation engine: reads the preference model and adjusts runtime
 * parameters for the next optimization call. Rule-based (not ML),
 * fully explainable, conservative defaults.
 *
 * Three-layer architecture:
 *   Layer 1: Session learning (in-memory episodes → preference model)
 *   Layer 2: Smart defaults (task-type-based presets)
 *   Layer 3: User overrides (runtime config via commands)
 *
 * Priority: Layer 3 > Layer 1 > Layer 2 > base config.
 *
 * @module adapt
 */
import type { PreferenceModel } from './preference.js';
import type { TaskType } from './meta.js';
/** Adaptation suggestions produced by the engine. */
export interface AdaptationHints {
    /** Suggested optimization profile (if different from current). */
    profile?: 'balanced' | 'fast';
    /** Suggested local template mode (if different from current). */
    localTemplate?: 'on' | 'off' | 'hybrid';
    /** Suggested temperature (if different from current). */
    temperature?: number;
    /** Reason for each suggestion (for logging/debugging). */
    reasons: string[];
}
/** Configuration for adaptation thresholds. */
export interface AdaptConfig {
    /** Minimum episodes before adaptation kicks in (avoid small-sample bias). */
    minEpisodes: number;
    /** Edit rate threshold: above this → switch to balanced. */
    highEditRate: number;
    /** Edit rate threshold: below this → switch to fast. */
    lowEditRate: number;
    /** Local acceptance rate threshold: below this → disable local. */
    lowLocalAcceptance: number;
    /** Local acceptance rate threshold: above this → prefer local. */
    highLocalAcceptance: number;
    /** Quality trend decline threshold (absolute drop). */
    qualityDeclineThreshold: number;
}
/** Default adaptation config. */
export declare const DEFAULT_ADAPT_CONFIG: AdaptConfig;
/**
 * Layer 2: Smart defaults by task type.
 * These are pre-tuned presets that work well for each task category.
 * Used when no user override (Layer 3) and no session learning (Layer 1) exists.
 */
export interface SmartDefaults {
    profile: 'balanced' | 'fast';
    localTemplate: 'on' | 'off' | 'hybrid';
    temperature: number;
}
/** Get smart defaults for a task type. */
export declare function getSmartDefaults(taskType: TaskType): SmartDefaults;
/**
 * Layer 3: User overrides (runtime, set via commands).
 * Stored in memory; survives across optimize calls within a session.
 * `undefined` means "not set by user" (fall through to Layer 1/2).
 */
export interface UserOverrides {
    profile?: 'balanced' | 'fast';
    localTemplate?: 'on' | 'off' | 'hybrid';
    temperature?: number;
}
/**
 * Compute adaptation hints based on the current preference model
 * and the active configuration. Returns suggestions that the
 * optimizer can choose to apply.
 */
export declare function computeAdaptation(prefs: PreferenceModel, currentProfile: 'balanced' | 'fast', currentLocalTemplate: 'on' | 'off' | 'hybrid', currentTemperature: number, config?: AdaptConfig): AdaptationHints;
/** Format adaptation hints as human-readable text. */
export declare function formatAdaptationHints(hints: AdaptationHints, lang?: 'zh' | 'en'): string;
/**
 * Layer 1+2+3 resolution: compute final parameters from three layers.
 *
 * 实际优先级（与实现一致）：Layer 3（用户覆盖）> Layer 1（会话学习）>
 * Layer 2 起点（smart defaults）——但**无会话学习时回落 base config**：
 * 冷启动/autoAdapt 关时直接用用户显式配置（cordis.patch.yml），避免
 * smart defaults 与显式配置打架。即完整顺序为：
 * Layer 3 > Layer 1（有 session hints）> base config（无 session hints）>
 * Layer 2 smart 仅作 Layer 1 部分命中时的字段级起点。
 *
 * @param taskType - Detected task type for smart defaults
 * @param sessionHints - Layer 1 adaptation hints (from episode log), may be empty
 * @param userOverrides - Layer 3 user overrides, may be all undefined
 * @param baseConfig - Base config values (from cordis.patch.yml)
 */
export declare function resolveParams(taskType: TaskType, sessionHints: AdaptationHints, userOverrides: UserOverrides, baseConfig: {
    profile: 'balanced' | 'fast';
    localTemplate: 'on' | 'off' | 'hybrid';
    temperature: number;
}): {
    profile: 'balanced' | 'fast';
    localTemplate: 'on' | 'off' | 'hybrid';
    temperature: number;
    source: string;
};
