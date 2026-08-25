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

import type { PreferenceModel } from './preference.js'
import type { OptimizeStats } from './optimizer.js'

/** One recorded optimization event (success or failure). */
export interface StatusEvent {
  ts: number
  method: string
  ok: boolean
  errorCode?: string
  outputTokens?: number
  durationMs?: number
  local?: boolean
}

/** Maximum buffered events (FIFO). */
export const STATUS_EVENT_MAX = 20

/** Snapshot handed to the formatter. */
export interface StatusSnapshot {
  effective: {
    profile: 'balanced' | 'fast'
    localTemplate: 'auto' | 'on' | 'off' | 'hybrid'
    temperature: number
    source: string
  }
  stats: OptimizeStats
  prefs: PreferenceModel
  recentEvents: readonly StatusEvent[]
  autoAdapt: boolean
  minAdaptEpisodes: number
  settingsPanel: boolean
}

/** Map a resolution source token to a human label. */
function sourceLabel(source: string, lang: 'zh' | 'en'): string {
  if (lang === 'zh') {
    switch (source) {
      case 'user:profile': case 'user:local': case 'user:temp': return '用户覆盖（命令，会话级）'
      case 'session:profile': case 'session:local': case 'session:temp': return '会话学习（Layer 1）'
      case 'config': return '基础配置（设置/entry-config）'
      case 'smart:code': case 'smart:writing': case 'smart:analysis': case 'smart:ops': case 'smart:other': return '智能默认值（Layer 2）'
      default: return source
    }
  }
  switch (source) {
    case 'user:profile': case 'user:local': case 'user:temp': return 'user override (command, session)'
    case 'session:profile': case 'session:local': case 'session:temp': return 'session learning (Layer 1)'
    case 'config': return 'base config (settings/entry-config)'
    case 'smart:code': case 'smart:writing': case 'smart:analysis': case 'smart:ops': case 'smart:other': return 'smart default (Layer 2)'
    default: return source
  }
}

/** Format a millisecond duration compactly. */
function fmtMs(ms: number, lang: 'zh' | 'en'): string {
  if (ms >= 60000) {
    const s = (ms / 60000).toFixed(1)
    return lang === 'zh' ? `${s} 分钟` : `${s} min`
  }
  return `${Math.round(ms)} ms`
}

/** Format the full status block. */
export function formatStatus(snapshot: StatusSnapshot, lang: 'zh' | 'en' = 'zh'): string {
  const lines: string[] = []
  const { effective, stats, prefs, recentEvents } = snapshot

  if (lang === 'zh') {
    lines.push('📋 prompt-optimizer 运行状态')
    lines.push('')
    lines.push('⚙️ 当前生效参数：')
    lines.push(`  Profile: ${effective.profile} ｜ 本地模板: ${effective.localTemplate} ｜ 温度: ${effective.temperature}`)
    lines.push(`  来源: ${sourceLabel(effective.source, lang)}`)
    lines.push(`  自迭代: ${snapshot.autoAdapt ? '开（≥' + snapshot.minAdaptEpisodes + ' 次生效）' : '关'} ｜ 设置面板: ${snapshot.settingsPanel ? '可用' : '不可用（走 cordis.patch.yml）'}`)
    lines.push('')
    lines.push('📊 运行统计：')
    lines.push(`  总次数 ${stats.runs}（成功 ${stats.success} / 失败 ${stats.failed} / 缓存 ${stats.cached}）`)
    lines.push(`  本地直出 ${stats.local}（精修 ${stats.refined}）｜ 平均耗时 ${fmtMs(stats.avgCallMs, lang)}（最长 ${fmtMs(stats.maxDurationMs, lang)}）`)
    lines.push(`  平均调用 ${stats.callCount > 0 ? (stats.callCount / Math.max(1, stats.runs)).toFixed(1) : 0} 次/次优化 ｜ 上次输出 ${stats.lastOutputTokens} tok`)
    lines.push('')
    lines.push('🧠 偏好模型（最近 ' + prefs.total + ' 次）：')
    if (prefs.total > 0) {
      if (prefs.dominantTaskType !== undefined) lines.push(`  最常用: ${prefs.dominantTaskType}`)
      lines.push(`  本地模板使用率 ${Math.round(prefs.localUsageRate * 100)}% / 接受率 ${Math.round(prefs.localAcceptanceRate * 100)}%`)
      lines.push(`  平均质量 ${prefs.avgQuality.toFixed(2)}（${prefs.feedbackCount} 次反馈）｜ 编辑率 ${Math.round(prefs.editRate * 100)}%`)
    } else {
      lines.push('  暂无记录，使用 /optimize 后生成。')
    }
    lines.push('')
    lines.push('🕘 最近事件（' + recentEvents.length + '）：')
    if (recentEvents.length === 0) {
      lines.push('  暂无。')
    } else {
      for (const ev of recentEvents.slice(-6).reverse()) {
        const time = new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false })
        const tag = ev.ok ? '✅' : '❌'
        const detail = ev.ok
          ? `${ev.outputTokens !== undefined ? ev.outputTokens + ' tok' : ''}${ev.local ? ' 本地' : ''}`
          : (ev.errorCode ?? 'error')
        lines.push(`  ${time} ${tag} ${ev.method} ${detail}${ev.durationMs !== undefined ? ' · ' + fmtMs(ev.durationMs, lang) : ''}`)
      }
    }
    lines.push('')
    lines.push('（设置项请在 Harness 设置 → 插件设置调整；命令覆盖为会话级）')
  } else {
    lines.push('📋 prompt-optimizer status')
    lines.push('')
    lines.push('⚙️ Effective params:')
    lines.push(`  Profile: ${effective.profile} ｜ Local template: ${effective.localTemplate} ｜ Temp: ${effective.temperature}`)
    lines.push(`  Source: ${sourceLabel(effective.source, lang)}`)
    lines.push(`  Auto-adapt: ${snapshot.autoAdapt ? 'on (≥' + snapshot.minAdaptEpisodes + ' runs)' : 'off'} ｜ Settings panel: ${snapshot.settingsPanel ? 'available' : 'unavailable (cordis.patch.yml)'}`)
    lines.push('')
    lines.push('📊 Stats:')
    lines.push(`  Runs ${stats.runs} (ok ${stats.success} / fail ${stats.failed} / cached ${stats.cached})`)
    lines.push(`  Local ${stats.local} (refined ${stats.refined}) ｜ avg ${fmtMs(stats.avgCallMs, lang)} (max ${fmtMs(stats.maxDurationMs, lang)})`)
    lines.push(`  Avg calls ${stats.callCount > 0 ? (stats.callCount / Math.max(1, stats.runs)).toFixed(1) : 0}/run ｜ last out ${stats.lastOutputTokens} tok`)
    lines.push('')
    lines.push('🧠 Preference model (last ' + prefs.total + ' runs):')
    if (prefs.total > 0) {
      if (prefs.dominantTaskType !== undefined) lines.push(`  Dominant: ${prefs.dominantTaskType}`)
      lines.push(`  Local usage ${Math.round(prefs.localUsageRate * 100)}% / acceptance ${Math.round(prefs.localAcceptanceRate * 100)}%`)
      lines.push(`  Avg quality ${prefs.avgQuality.toFixed(2)} (${prefs.feedbackCount} feedback) ｜ edit ${Math.round(prefs.editRate * 100)}%`)
    } else {
      lines.push('  No records yet — run /optimize to build them.')
    }
    lines.push('')
    lines.push('🕘 Recent events (' + recentEvents.length + '):')
    if (recentEvents.length === 0) {
      lines.push('  none.')
    } else {
      for (const ev of recentEvents.slice(-6).reverse()) {
        const time = new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false })
        const tag = ev.ok ? '✅' : '❌'
        const detail = ev.ok
          ? `${ev.outputTokens !== undefined ? ev.outputTokens + ' tok' : ''}${ev.local ? ' local' : ''}`
          : (ev.errorCode ?? 'error')
        lines.push(`  ${time} ${tag} ${ev.method} ${detail}${ev.durationMs !== undefined ? ' · ' + fmtMs(ev.durationMs, lang) : ''}`)
      }
    }
    lines.push('')
    lines.push('(Adjust options in Harness Settings → plugin settings; command overrides are session-scoped)')
  }

  return lines.join('\n')
}
