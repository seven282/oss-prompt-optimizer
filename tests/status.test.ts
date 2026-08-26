import { describe, expect, it } from 'vitest'
import { STATUS_EVENT_MAX, formatStatus, type StatusSnapshot } from '../src/status.js'

/** Minimal realistic snapshot. */
function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    effective: { profile: 'balanced', localTemplate: 'off', temperature: 0.2, source: 'config' },
    stats: {
      runs: 3, success: 2, failed: 1, cached: 1, local: 1, refined: 0,
      totalDurationMs: 3000, maxDurationMs: 2000, lastOutputTokens: 800,
      lastCallMs: 900, avgCallMs: 900, maxCallMs: 1200, totalCallMs: 2700, callCount: 3,
      lastRunCalls: 2, lastInputTokens: 500,
    },
    prefs: {
      total: 2, taskTypeFreq: new Map([['writing', 2]]), subtypeFreq: new Map(),
      dominantTaskType: 'writing', localAcceptanceRate: 1, localUsageRate: 0.5,
      qualityTrend: [], avgQuality: 1, editRate: 0, avgOutputTokens: 700,
      avgInputTokens: 400, avgDurationMs: 900, profileFreq: new Map([['balanced', 2]]),
      feedbackCount: 1,
    },
    recentEvents: [
      { ts: Date.now() - 1000, method: 'optimize', ok: true, outputTokens: 800, durationMs: 900, local: true },
      { ts: Date.now() - 2000, method: 'optimize', ok: false, errorCode: 'TIMEOUT', durationMs: 1200 },
    ],
    autoAdapt: false,
    minAdaptEpisodes: 10,
    settingsPanel: true,
    ...overrides,
  }
}

describe('formatStatus (P1, 1.7.9)', () => {
  it('renders effective params with the resolution source', () => {
    const zh = formatStatus(makeSnapshot(), 'zh')
    expect(zh).toContain('当前生效参数')
    expect(zh).toContain('Profile: balanced')
    expect(zh).toContain('温度: 0.2')
    expect(zh).toContain('基础配置（设置/entry-config）')
    expect(zh).toContain('设置面板: 可用')
  })

  it('maps a user-override source label correctly (zh/en)', () => {
    const snapshot = makeSnapshot({ effective: { profile: 'fast', localTemplate: 'on', temperature: 0.3, source: 'user:profile' } })
    expect(formatStatus(snapshot, 'zh')).toContain('用户覆盖（命令，会话级）')
    expect(formatStatus(snapshot, 'en')).toContain('user override (command, session)')
  })

  it('renders stats and preference summary', () => {
    const text = formatStatus(makeSnapshot(), 'zh')
    expect(text).toContain('总次数 3（成功 2 / 失败 1 / 缓存 1）')
    expect(text).toContain('本地直出 1')
    expect(text).toContain('最常用: writing')
    expect(text).toContain('本地模板使用率 50% / 接受率 100%')
  })

  it('lists recent events newest-first with ok/fail markers', () => {
    const text = formatStatus(makeSnapshot(), 'zh')
    expect(text).toContain('✅ optimize')
    expect(text).toContain('❌ optimize')
    expect(text).toContain('TIMEOUT')
  })

  it('handles empty history gracefully', () => {
    const text = formatStatus(makeSnapshot({ prefs: { total: 0, taskTypeFreq: new Map(), subtypeFreq: new Map(), localAcceptanceRate: 0, localUsageRate: 0, qualityTrend: [], avgQuality: 0, editRate: 0, avgOutputTokens: 0, avgInputTokens: 0, avgDurationMs: 0, profileFreq: new Map(), feedbackCount: 0 }, recentEvents: [] }), 'zh')
    expect(text).toContain('暂无记录')
    expect(text).toContain('暂无。')
  })

  it('exports a sane event buffer cap', () => {
    expect(STATUS_EVENT_MAX).toBe(20)
  })
})
