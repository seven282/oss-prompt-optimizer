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

import type { Episode, EpisodeLog } from './episode.js'
import type { TaskType } from './meta.js'

/** Aggregated preference statistics. */
export interface PreferenceModel {
  /** Total episodes analyzed. */
  total: number
  /** Task-type frequency (e.g. { writing: 15, code: 10 }). */
  taskTypeFreq: Map<TaskType, number>
  /** Subtype frequency (e.g. { 'writing-report': 12, 'code-bugfix': 8 }). */
  subtypeFreq: Map<string, number>
  /** Dominant task type (most frequent). */
  dominantTaskType?: TaskType
  /** Dominant subtype (most frequent). */
  dominantSubtype?: string
  /** Local template acceptance rate (episodes where local=true and accepted=true / total local). */
  localAcceptanceRate: number
  /** Local template usage rate (episodes where local=true / total). */
  localUsageRate: number
  /** Quality trend: rolling average quality over time (windowed). */
  qualityTrend: number[]
  /** Average quality score across episodes with feedback. */
  avgQuality: number
  /** Edit rate: fraction of episodes where accepted=false (user edited/rejected). */
  editRate: number
  /** Average output tokens per episode. */
  avgOutputTokens: number
  /** Average input tokens per episode. */
  avgInputTokens: number
  /** Average duration (ms) per episode. */
  avgDurationMs: number
  /** Profile usage distribution (e.g. { fast: 12, balanced: 8 }). */
  profileFreq: Map<string, number>
  /** Episodes with quality feedback count. */
  feedbackCount: number
}

/** Compute preference model from episode log (windowed to last N episodes). */
export function computePreferences(log: EpisodeLog, windowSize = 100): PreferenceModel {
  const episodes = log.recent(windowSize) as Episode[]
  const total = episodes.length

  if (total === 0) {
    return emptyPreference()
  }

  // Frequency maps
  const taskTypeFreq = new Map<TaskType, number>()
  const subtypeFreq = new Map<string, number>()
  const profileFreq = new Map<string, number>()

  let localCount = 0
  let localAcceptedCount = 0
  let editCount = 0
  let feedbackCount = 0
  let totalQuality = 0
  let totalOutputTokens = 0
  let totalInputTokens = 0
  let totalDurationMs = 0

  for (const ep of episodes) {
    // Task type frequency
    taskTypeFreq.set(ep.taskType, (taskTypeFreq.get(ep.taskType) ?? 0) + 1)

    // Subtype frequency
    if (ep.subtype !== undefined) {
      subtypeFreq.set(ep.subtype, (subtypeFreq.get(ep.subtype) ?? 0) + 1)
    }

    // Profile frequency
    profileFreq.set(ep.profile, (profileFreq.get(ep.profile) ?? 0) + 1)

    // Local acceptance
    if (ep.local) {
      localCount++
      if (ep.accepted === true) localAcceptedCount++
    }

    // Edit rate (accepted === false means user edited/rejected)
    if (ep.accepted === false) editCount++

    // Quality feedback
    if (ep.quality !== undefined) {
      feedbackCount++
      totalQuality += ep.quality
    }

    totalOutputTokens += ep.outputTokens
    totalInputTokens += ep.inputTokens
    totalDurationMs += ep.durationMs
  }

  // Dominant
  let dominantTaskType: TaskType | undefined
  let maxTaskCount = 0
  for (const [tt, count] of taskTypeFreq) {
    if (count > maxTaskCount) {
      maxTaskCount = count
      dominantTaskType = tt
    }
  }

  let dominantSubtype: string | undefined
  let maxSubCount = 0
  for (const [st, count] of subtypeFreq) {
    if (count > maxSubCount) {
      maxSubCount = count
      dominantSubtype = st
    }
  }

  // Quality trend: rolling average over windows of 10
  const qualityTrend = computeQualityTrend(episodes, 10)

  return {
    total,
    taskTypeFreq,
    subtypeFreq,
    dominantTaskType,
    dominantSubtype,
    localAcceptanceRate: localCount > 0 ? localAcceptedCount / localCount : 0,
    localUsageRate: total > 0 ? localCount / total : 0,
    qualityTrend,
    avgQuality: feedbackCount > 0 ? totalQuality / feedbackCount : 0,
    editRate: total > 0 ? editCount / total : 0,
    avgOutputTokens: total > 0 ? Math.round(totalOutputTokens / total) : 0,
    avgInputTokens: total > 0 ? Math.round(totalInputTokens / total) : 0,
    avgDurationMs: total > 0 ? Math.round(totalDurationMs / total) : 0,
    profileFreq,
    feedbackCount,
  }
}

/** Compute rolling average quality trend. */
function computeQualityTrend(episodes: readonly Episode[], windowSize: number): number[] {
  const trend: number[] = []
  const withQuality = episodes.filter(ep => ep.quality !== undefined)
  if (withQuality.length === 0) return trend

  for (let i = 0; i < withQuality.length; i += windowSize) {
    const window = withQuality.slice(i, i + windowSize)
    const avg = window.reduce((sum, ep) => sum + (ep.quality ?? 0), 0) / window.length
    trend.push(Math.round(avg * 100) / 100)
  }

  return trend
}

/** Empty preference model. */
function emptyPreference(): PreferenceModel {
  return {
    total: 0,
    taskTypeFreq: new Map(),
    subtypeFreq: new Map(),
    localAcceptanceRate: 0,
    localUsageRate: 0,
    qualityTrend: [],
    avgQuality: 0,
    editRate: 0,
    avgOutputTokens: 0,
    avgInputTokens: 0,
    avgDurationMs: 0,
    profileFreq: new Map(),
    feedbackCount: 0,
  }
}

/** Format preference model as human-readable text (for /optimize --insights). */
export function formatPreferences(prefs: PreferenceModel, lang: 'zh' | 'en' = 'zh'): string {
  if (prefs.total === 0) {
    return lang === 'zh'
      ? '暂无优化记录。使用 /optimize 优化指令后，此处将展示使用偏好分析。'
      : 'No optimization records yet. Use /optimize to optimize an instruction, and usage analytics will appear here.'
  }

  const lines: string[] = []

  if (lang === 'zh') {
    lines.push(`📊 优化统计（最近 ${prefs.total} 次）`)
    lines.push('')

    // Task type breakdown
    lines.push('📌 任务类型分布：')
    for (const [tt, count] of sortedEntries(prefs.taskTypeFreq)) {
      const pct = Math.round((count / prefs.total) * 100)
      lines.push(`  ${tt}: ${count} 次 (${pct}%)`)
    }
    if (prefs.dominantTaskType !== undefined) {
      lines.push(`  → 最常用：${prefs.dominantTaskType}`)
    }
    lines.push('')

    // Top subtypes
    if (prefs.subtypeFreq.size > 0) {
      lines.push('🏷️ 高频子类（前 5）：')
      const top5 = sortedEntries(prefs.subtypeFreq).slice(0, 5)
      for (const [st, count] of top5) {
        const pct = Math.round((count / prefs.total) * 100)
        lines.push(`  ${st}: ${count} 次 (${pct}%)`)
      }
      lines.push('')
    }

    // Local template performance
    lines.push('⚡ 本地模板：')
    lines.push(`  使用率：${Math.round(prefs.localUsageRate * 100)}%`)
    lines.push(`  接受率：${Math.round(prefs.localAcceptanceRate * 100)}%`)
    lines.push('')

    // Quality
    if (prefs.feedbackCount > 0) {
      lines.push(`🎯 质量评分：${prefs.avgQuality.toFixed(2)}（基于 ${prefs.feedbackCount} 次反馈）`)
      lines.push(`  编辑率：${Math.round(prefs.editRate * 100)}%`)
    }

    // Cost
    lines.push('')
    lines.push(`💰 平均成本：输入 ${prefs.avgInputTokens} tok / 输出 ${prefs.avgOutputTokens} tok`)
    lines.push(`⏱️ 平均耗时：${prefs.avgDurationMs} ms`)

    // Profile usage
    if (prefs.profileFreq.size > 0) {
      lines.push('')
      lines.push('⚙️ Profile 分布：')
      for (const [pf, count] of sortedEntries(prefs.profileFreq)) {
        lines.push(`  ${pf}: ${count} 次`)
      }
    }
  } else {
    lines.push(`📊 Optimization Stats (last ${prefs.total} runs)`)
    lines.push('')

    lines.push('📌 Task Type Distribution:')
    for (const [tt, count] of sortedEntries(prefs.taskTypeFreq)) {
      const pct = Math.round((count / prefs.total) * 100)
      lines.push(`  ${tt}: ${count} (${pct}%)`)
    }
    if (prefs.dominantTaskType !== undefined) {
      lines.push(`  → Most used: ${prefs.dominantTaskType}`)
    }
    lines.push('')

    if (prefs.subtypeFreq.size > 0) {
      lines.push('🏷️ Top Subtypes (5):')
      for (const [st, count] of sortedEntries(prefs.subtypeFreq).slice(0, 5)) {
        const pct = Math.round((count / prefs.total) * 100)
        lines.push(`  ${st}: ${count} (${pct}%)`)
      }
      lines.push('')
    }

    lines.push('⚡ Local Template:')
    lines.push(`  Usage: ${Math.round(prefs.localUsageRate * 100)}%`)
    lines.push(`  Acceptance: ${Math.round(prefs.localAcceptanceRate * 100)}%`)
    lines.push('')

    if (prefs.feedbackCount > 0) {
      lines.push(`🎯 Quality: ${prefs.avgQuality.toFixed(2)} (from ${prefs.feedbackCount} feedback)`)
      lines.push(`  Edit rate: ${Math.round(prefs.editRate * 100)}%`)
    }

    lines.push('')
    lines.push(`💰 Avg cost: ${prefs.avgInputTokens} tok in / ${prefs.avgOutputTokens} tok out`)
    lines.push(`⏱️ Avg time: ${prefs.avgDurationMs} ms`)

    if (prefs.profileFreq.size > 0) {
      lines.push('')
      lines.push('⚙️ Profile Distribution:')
      for (const [pf, count] of sortedEntries(prefs.profileFreq)) {
        lines.push(`  ${pf}: ${count}`)
      }
    }
  }

  return lines.join('\n')
}

/** Sort map entries by value descending. */
function sortedEntries(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}
