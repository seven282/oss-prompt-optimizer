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

import type { PreferenceModel } from './preference.js'
import type { TaskType } from './meta.js'

/** Adaptation suggestions produced by the engine. */
export interface AdaptationHints {
  /** Suggested optimization profile (if different from current). */
  profile?: 'balanced' | 'fast'
  /** Suggested local template mode (if different from current). */
  localTemplate?: 'auto' | 'on' | 'off' | 'hybrid'
  /** Suggested temperature (if different from current). */
  temperature?: number
  /** Reason for each suggestion (for logging/debugging). */
  reasons: string[]
}

/** Configuration for adaptation thresholds. */
export interface AdaptConfig {
  /** Minimum episodes before adaptation kicks in (avoid small-sample bias). */
  minEpisodes: number
  /** Edit rate threshold: above this → switch to balanced. */
  highEditRate: number
  /** Edit rate threshold: below this → switch to fast. */
  lowEditRate: number
  /** Local acceptance rate threshold: below this → disable local. */
  lowLocalAcceptance: number
  /** Local acceptance rate threshold: above this → prefer local. */
  highLocalAcceptance: number
  /** Quality trend decline threshold (absolute drop). */
  qualityDeclineThreshold: number
}

/** Default adaptation config. */
export const DEFAULT_ADAPT_CONFIG: AdaptConfig = {
  minEpisodes: 10,
  highEditRate: 0.4,
  lowEditRate: 0.15,
  lowLocalAcceptance: 0.4,
  highLocalAcceptance: 0.7,
  qualityDeclineThreshold: 0.15,
}

/**
 * Layer 2: Smart defaults by task type.
 * These are pre-tuned presets that work well for each task category.
 * Used when no user override (Layer 3) and no session learning (Layer 1) exists.
 */
export interface SmartDefaults {
  profile: 'balanced' | 'fast'
  localTemplate: 'auto' | 'on' | 'off' | 'hybrid'
  temperature: number
}

const SMART_DEFAULTS: Record<TaskType, SmartDefaults> = {
  code:     { profile: 'fast',    localTemplate: 'auto', temperature: 0.15 },
  writing:  { profile: 'balanced', localTemplate: 'auto', temperature: 0.4  },
  analysis: { profile: 'balanced', localTemplate: 'auto', temperature: 0.2  },
  ops:      { profile: 'fast',    localTemplate: 'auto', temperature: 0.15 },
  other:    { profile: 'balanced', localTemplate: 'auto', temperature: 0.2  },
}

/** Get smart defaults for a task type. */
export function getSmartDefaults(taskType: TaskType): SmartDefaults {
  return SMART_DEFAULTS[taskType] ?? SMART_DEFAULTS.other
}

/**
 * Layer 3: User overrides (runtime, set via commands).
 * Stored in memory; survives across optimize calls within a session.
 * `undefined` means "not set by user" (fall through to Layer 1/2).
 */
export interface UserOverrides {
  profile?: 'balanced' | 'fast'
  localTemplate?: 'auto' | 'on' | 'off' | 'hybrid'
  temperature?: number
}

/**
 * Compute adaptation hints based on the current preference model
 * and the active configuration. Returns suggestions that the
 * optimizer can choose to apply.
 */
export function computeAdaptation(
  prefs: PreferenceModel,
  currentProfile: 'balanced' | 'fast',
  currentLocalTemplate: 'auto' | 'on' | 'off' | 'hybrid',
  currentTemperature: number,
  config: AdaptConfig = DEFAULT_ADAPT_CONFIG,
): AdaptationHints {
  const reasons: string[] = []
  const hints: AdaptationHints = { reasons }

  // Don't adapt with insufficient data
  if (prefs.total < config.minEpisodes) {
    reasons.push(`Insufficient data (${prefs.total}/${config.minEpisodes})`)
    return hints
  }

  // --- Profile adaptation ---
  if (prefs.editRate > config.highEditRate) {
    // Users are frequently editing/rejecting → need higher quality
    if (currentProfile === 'fast') {
      hints.profile = 'balanced'
      reasons.push(`High edit rate (${Math.round(prefs.editRate * 100)}% > ${Math.round(config.highEditRate * 100)}%) → switch to balanced`)
    }
  } else if (prefs.editRate < config.lowEditRate) {
    // Users rarely edit → can afford faster profile
    if (currentProfile === 'balanced') {
      hints.profile = 'fast'
      reasons.push(`Low edit rate (${Math.round(prefs.editRate * 100)}% < ${Math.round(config.lowEditRate * 100)}%) → switch to fast`)
    }
  }

  // --- Local template adaptation ---
  if (prefs.localUsageRate > 0.1) {
    // Only adapt if local template is actually being used
    if (prefs.localAcceptanceRate < config.lowLocalAcceptance) {
      if (currentLocalTemplate !== 'off') {
        hints.localTemplate = 'off'
        reasons.push(`Low local acceptance (${Math.round(prefs.localAcceptanceRate * 100)}% < ${Math.round(config.lowLocalAcceptance * 100)}%) → disable local`)
      }
    } else if (prefs.localAcceptanceRate > config.highLocalAcceptance) {
      if (currentLocalTemplate === 'off') {
        hints.localTemplate = 'auto'
        reasons.push(`High local acceptance (${Math.round(prefs.localAcceptanceRate * 100)}% > ${Math.round(config.highLocalAcceptance * 100)}%) → enable auto`)
      }
    }
  }

  // --- Temperature adaptation ---
  // If quality is declining and temperature is high → lower it
  if (prefs.qualityTrend.length >= 2) {
    const recent = prefs.qualityTrend[prefs.qualityTrend.length - 1] ?? 0
    const prev = prefs.qualityTrend[prefs.qualityTrend.length - 2] ?? 0
    if (prev - recent > config.qualityDeclineThreshold && currentTemperature > 0.3) {
      hints.temperature = Math.max(0.1, currentTemperature - 0.1)
      reasons.push(`Quality declining (${prev.toFixed(2)} → ${recent.toFixed(2)}) → lower temperature`)
    }
  }

  // If dominant task type is creative writing → slightly higher temperature
  if (prefs.dominantTaskType === 'writing' && prefs.total >= config.minEpisodes * 2) {
    const writingRatio = (prefs.taskTypeFreq.get('writing') ?? 0) / prefs.total
    if (writingRatio > 0.6 && currentTemperature < 0.4) {
      hints.temperature = 0.4
      reasons.push(`Dominant writing tasks (${Math.round(writingRatio * 100)}%) → slightly higher temperature for creativity`)
    }
  }

  return hints
}

/** Format adaptation hints as human-readable text. */
export function formatAdaptationHints(hints: AdaptationHints, lang: 'zh' | 'en' = 'zh'): string {
  if (hints.reasons.length === 0) {
    return lang === 'zh' ? '当前无需调整。' : 'No adjustments needed.'
  }

  const lines: string[] = []
  if (lang === 'zh') {
    lines.push('🔧 自适应建议：')
    if (hints.profile !== undefined) lines.push(`  Profile → ${hints.profile}`)
    if (hints.localTemplate !== undefined) lines.push(`  本地模板 → ${hints.localTemplate}`)
    if (hints.temperature !== undefined) lines.push(`  Temperature → ${hints.temperature.toFixed(1)}`)
    lines.push('')
    lines.push('原因：')
    for (const r of hints.reasons) lines.push(`  · ${r}`)
  } else {
    lines.push('🔧 Adaptation Suggestions:')
    if (hints.profile !== undefined) lines.push(`  Profile → ${hints.profile}`)
    if (hints.localTemplate !== undefined) lines.push(`  Local template → ${hints.localTemplate}`)
    if (hints.temperature !== undefined) lines.push(`  Temperature → ${hints.temperature.toFixed(1)}`)
    lines.push('')
    lines.push('Reasons:')
    for (const r of hints.reasons) lines.push(`  · ${r}`)
  }

  return lines.join('\n')
}

/**
 * Layer 1+2+3 resolution: compute final parameters from three layers.
 *
 * Priority: Layer 3 (user override) > Layer 1 (session learning) > Layer 2 (smart defaults) > base config.
 *
 * @param taskType - Detected task type for smart defaults
 * @param sessionHints - Layer 1 adaptation hints (from episode log), may be empty
 * @param userOverrides - Layer 3 user overrides, may be all undefined
 * @param baseConfig - Base config values (from cordis.patch.yml)
 */
export function resolveParams(
  taskType: TaskType,
  sessionHints: AdaptationHints,
  userOverrides: UserOverrides,
  baseConfig: { profile: 'balanced' | 'fast'; localTemplate: 'auto' | 'on' | 'off' | 'hybrid'; temperature: number },
): { profile: 'balanced' | 'fast'; localTemplate: 'auto' | 'on' | 'off' | 'hybrid'; temperature: number; source: string } {
  const smart = getSmartDefaults(taskType)

  // Layer 2: start with smart defaults
  let profile = smart.profile
  let localTemplate = smart.localTemplate
  let temperature = smart.temperature
  let source = `smart:${taskType}`

  // Layer 1: session learning overrides smart defaults
  if (sessionHints.profile !== undefined) {
    profile = sessionHints.profile
    source = 'session:profile'
  }
  if (sessionHints.localTemplate !== undefined) {
    localTemplate = sessionHints.localTemplate
    source = 'session:local'
  }
  if (sessionHints.temperature !== undefined) {
    temperature = sessionHints.temperature
    source = 'session:temp'
  }

  // Layer 1 fallback: if no session hints produced (autoAdapt off / insufficient data),
  // use base config (user's cordis.patch.yml settings) instead of smart defaults.
  const hasSessionLearning = sessionHints.profile !== undefined
    || sessionHints.localTemplate !== undefined
    || sessionHints.temperature !== undefined
  if (!hasSessionLearning) {
    profile = baseConfig.profile
    localTemplate = baseConfig.localTemplate
    temperature = baseConfig.temperature
    source = 'config'
  }

  // Layer 3: user overrides always win
  if (userOverrides.profile !== undefined) {
    profile = userOverrides.profile
    source = 'user:profile'
  }
  if (userOverrides.localTemplate !== undefined) {
    localTemplate = userOverrides.localTemplate
    source = 'user:local'
  }
  if (userOverrides.temperature !== undefined) {
    temperature = userOverrides.temperature
    source = 'user:temp'
  }

  return { profile, localTemplate, temperature, source }
}
