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
      usageCalls: 4,
      inputTokens: 300, outputTokens: 1500, cacheReadTokens: 900,
      cacheWriteTokens: 100, reasoningTokens: 0,
      lastRunUsage: { calls: 2, inputTokens: 100, outputTokens: 700, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 0 },
      // Best-of-N selection + host feedback (1.12.0).
      selectRuns: 2, selectGains: 1, lastSelectCandidates: 3, lastSelectChosen: 2,
      lastSelectScore: 0.88, lastSelectGate: 3, feedbackSessions: 1, feedbackPositive: 4,
      feedbackNegative: 1, feedbackBiasApplied: 0,
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

  it('renders the provider-reported usage ledger (1.10.0)', () => {
    const text = formatStatus(makeSnapshot(), 'zh')
    // billed input = uncached 300 + cache read 900 + cache write 100
    expect(text).toContain('真实用量: 累计 input 1300（缓存读 900 / 写 100 / 未缓存 300）｜ output 1500')
    // 900 / 1300
    expect(text).toContain('缓存命中 69%')
    expect(text).toContain('4 次调用上报')
    // last run: input 100 + 200 cache read + 0 write, output 700, 2 of 2 calls
    expect(text).toContain('上次优化: input 300 ｜ output 700（2/2 次调用上报）')
    expect(formatStatus(makeSnapshot(), 'en')).toContain('Real usage: cumulative input 1300')
  })

  it('says the token counts are estimates when the adapter reported no usage', () => {
    const stats = { ...makeSnapshot().stats, usageCalls: 0, lastRunUsage: null }
    const text = formatStatus(makeSnapshot({ stats }), 'zh')
    expect(text).toContain('真实用量: 适配器未上报 usage')
    expect(text).not.toContain('缓存命中')
    expect(formatStatus(makeSnapshot({ stats }), 'en')).toContain('adapter reported no usage')
  })

  it('reports a zero-call last run for a cache hit or local render', () => {
    const stats = {
      ...makeSnapshot().stats,
      lastRunCalls: 0,
      lastRunUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    }
    expect(formatStatus(makeSnapshot({ stats }), 'zh')).toContain('上次优化: 0 次模型调用')
    expect(formatStatus(makeSnapshot({ stats }), 'en')).toContain('Last run: 0 model calls')
  })

  it('distinguishes "no model calls" from "calls that reported nothing"', () => {
    const zero = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const base = makeSnapshot().stats
    // No calls at all → a cache hit or a local render.
    const idle = formatStatus(makeSnapshot({ stats: { ...base, lastRunUsage: zero, lastRunCalls: 0 } }), 'zh')
    expect(idle).toContain('上次优化: 0 次模型调用（缓存命中或本地直出）')
    // Two real calls, adapter silent → must NOT claim the run was free.
    const silent = formatStatus(makeSnapshot({ stats: { ...base, lastRunUsage: zero, lastRunCalls: 2 } }), 'zh')
    expect(silent).toContain('上次优化: 2 次模型调用均未上报 usage')
    expect(silent).not.toContain('0 次模型调用')
    expect(formatStatus(makeSnapshot({ stats: { ...base, lastRunUsage: zero, lastRunCalls: 2 } }), 'en'))
      .toContain('2 model calls, none reported usage')
  })

  it('shows reasoning tokens only when the provider reported them', () => {
    const base = makeSnapshot().stats
    const withReasoning = formatStatus(makeSnapshot({ stats: { ...base, reasoningTokens: 120 } }), 'zh')
    expect(withReasoning).toContain('推理 120 tok')
    expect(formatStatus(makeSnapshot({ stats: base }), 'zh')).not.toContain('推理')
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
