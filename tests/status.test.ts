import { describe, expect, it } from 'vitest'
import { STATUS_MAX_EVENTS, formatStatus, type StatusSnapshot } from '../src/status.js'

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
      // The route the last run called (1.13.0); null after a run that made no
      // model call. No reasoning effort here: the tests below add one where
      // they mean to, so a bare fixture cannot smuggle the word 推理 into
      // assertions that are about something else.
      lastRunRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
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

  it('names the model the last run called (1.13.0)', () => {
    const base = makeSnapshot().stats
    expect(formatStatus(makeSnapshot(), 'zh')).toContain('目标模型: deepseek-official/deepseek-v4-flash')
    expect(formatStatus(makeSnapshot(), 'en')).toContain('Target model: deepseek-official/deepseek-v4-flash')
    // The reasoning effort is optional in the route: shown when reported…
    const withEffort = { ...base, lastRunRoute: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
    expect(formatStatus(makeSnapshot({ stats: withEffort }), 'zh')).toContain('目标模型: p/m ｜ 推理档 high')
    expect(formatStatus(makeSnapshot({ stats: withEffort }), 'en')).toContain('Target model: p/m ｜ effort high')
    // …and absent (not fabricated) when it is not.
    expect(formatStatus(makeSnapshot(), 'zh')).not.toContain('推理档')
  })

  it('prints no target-model line after a run that called no model', () => {
    // Reverse control for the line above: the route is per-run, so a local
    // render or a cache hit must not leave the previous model on screen — the
    // feature is silent, not "carried over".
    const idle = { ...makeSnapshot().stats, lastRunRoute: null }
    const zh = formatStatus(makeSnapshot({ stats: idle }), 'zh')
    expect(zh).not.toContain('目标模型')
    expect(formatStatus(makeSnapshot({ stats: idle }), 'en')).not.toContain('Target model')
    // …while a route still produces it, so the assertion above cannot pass by
    // the whole block being broken.
    expect(formatStatus(makeSnapshot({ stats: { ...idle, lastRunRoute: { provider: 'p', model: 'm' } } }), 'zh'))
      .toContain('目标模型: p/m')
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
    expect(STATUS_MAX_EVENTS).toBe(20)
  })

  it('renders the best-of-N and host-feedback lines (1.12.0)', () => {
    const base = makeSnapshot().stats
    const text = formatStatus(makeSnapshot({ stats: base }), 'zh')
    // Selected 2 of 3 candidates at 0.88 with 3 through the gate; 2 runs, 1
    // of which replaced the first draw.
    expect(text).toContain('择优: 上次 2/3 候选（0.88，结构门 3）')
    expect(text).toContain('累计 2 次择优，其中 1 次换用非首个候选（50%）')
    expect(text).toContain('宿主反馈: 👍 4 / 👎 1')
    const en = formatStatus(makeSnapshot({ stats: base }), 'en')
    expect(en).toContain('Selection: last 2/3 candidates')
    expect(en).toContain('Host feedback: 👍 4 / 👎 1')
  })

  it('renders no selection or feedback line when neither ever ran', () => {
    const base = makeSnapshot().stats
    const idle = {
      ...base,
      selectRuns: 0, selectGains: 0, lastSelectCandidates: 0, lastSelectChosen: 0,
      lastSelectScore: 0, lastSelectGate: 0,
      feedbackSessions: 0, feedbackPositive: 0, feedbackNegative: 0, feedbackBiasApplied: 0,
    }
    const text = formatStatus(makeSnapshot({ stats: idle }), 'zh')
    // An unrun feature must not look like a measured zero.
    expect(text).not.toContain('择优:')
    expect(text).not.toContain('宿主反馈:')
    expect(formatStatus(makeSnapshot({ stats: idle }), 'en')).not.toContain('Selection:')
  })

  it('states the temperature bias when feedback moved it', () => {
    const base = { ...makeSnapshot().stats, feedbackBiasApplied: 0.1 }
    expect(formatStatus(makeSnapshot({ stats: base }), 'zh')).toContain('温度偏置 +0.1')
    expect(formatStatus(makeSnapshot({ stats: { ...base, feedbackBiasApplied: -0.1 } }), 'zh')).toContain('温度偏置 -0.1')
    expect(formatStatus(makeSnapshot({ stats: { ...base, feedbackBiasApplied: 0 } }), 'zh')).toContain('温度偏置 无偏置')
  })
})

describe('formatStatus branch matrix', () => {
  it('maps every resolution-source token in both languages', () => {
    const cases: [string, string, string][] = [
      ['user:profile', '用户覆盖（命令，会话级）', 'user override (command, session)'],
      ['user:local', '用户覆盖（命令，会话级）', 'user override (command, session)'],
      ['user:temp', '用户覆盖（命令，会话级）', 'user override (command, session)'],
      ['session:profile', '会话学习（Layer 1）', 'session learning (Layer 1)'],
      ['session:local', '会话学习（Layer 1）', 'session learning (Layer 1)'],
      ['session:temp', '会话学习（Layer 1）', 'session learning (Layer 1)'],
      ['smart:code', '智能默认值（Layer 2）', 'smart default (Layer 2)'],
      ['smart:writing', '智能默认值（Layer 2）', 'smart default (Layer 2)'],
      ['smart:analysis', '智能默认值（Layer 2）', 'smart default (Layer 2)'],
      ['smart:ops', '智能默认值（Layer 2）', 'smart default (Layer 2)'],
      ['smart:other', '智能默认值（Layer 2）', 'smart default (Layer 2)'],
    ]
    for (const [source, zh, en] of cases) {
      const snapshot = makeSnapshot({ effective: { profile: 'balanced', localTemplate: 'off', temperature: 0.2, source } })
      expect(formatStatus(snapshot, 'zh')).toContain(zh)
      expect(formatStatus(snapshot, 'en')).toContain(en)
    }
    // An unknown token is echoed rather than invented — and must not be
    // swallowed into one of the labels above.
    const unknown = makeSnapshot({ effective: { profile: 'balanced', localTemplate: 'off', temperature: 0.2, source: 'exotic:source' } })
    expect(formatStatus(unknown, 'zh')).toContain('exotic:source')
    expect(formatStatus(unknown, 'en')).toContain('exotic:source')
  })

  it('switches the duration unit to minutes past one minute', () => {
    const stats = { ...makeSnapshot().stats, avgCallMs: 90000, maxDurationMs: 125000 }
    expect(formatStatus(makeSnapshot({ stats }), 'zh')).toContain('平均耗时 1.5 分钟（最长 2.1 分钟）')
    expect(formatStatus(makeSnapshot({ stats }), 'en')).toContain('avg 1.5 min (max 2.1 min)')
  })

  it('handles a snapshot with no records and no events in English too', () => {
    const text = formatStatus(makeSnapshot({
      prefs: {
        total: 0, taskTypeFreq: new Map(), subtypeFreq: new Map(), localAcceptanceRate: 0,
        localUsageRate: 0, qualityTrend: [], avgQuality: 0, editRate: 0, avgOutputTokens: 0,
        avgInputTokens: 0, avgDurationMs: 0, profileFreq: new Map(), feedbackCount: 0,
      },
      recentEvents: [],
    }), 'en')
    expect(text).toContain('No records yet')
    expect(text).toContain('none.')
  })

  it('omits the dominant task line when no subtype dominates', () => {
    const prefs = { ...makeSnapshot().prefs, dominantTaskType: undefined }
    const zh = formatStatus(makeSnapshot({ prefs }), 'zh')
    expect(zh).not.toContain('最常用:')
    expect(formatStatus(makeSnapshot({ prefs }), 'en')).not.toContain('Dominant:')
  })

  it('renders every eval verdict label, and degrades to n/a fields', () => {
    const base = { runs: 3, at: Date.UTC(2026, 0, 2, 3, 4, 5) }
    const pairs: [string, string, string][] = [
      ['pass', '通过', 'pass'],
      ['regress', '回归', 'REGRESS'],
      ['below-threshold', '未达阈值', 'below threshold'],
      ['no-baseline', '无基线', 'no baseline'],
      ['no-score', '无判分', 'nothing scored'],
    ]
    for (const [verdict, zh, en] of pairs) {
      const snapshot = makeSnapshot({ evalSummary: { ...base, aggregate: 0.7, baseline: 0.6, verdict } })
      expect(formatStatus(snapshot, 'zh')).toContain(`（基线 0.60，${zh}）`)
      expect(formatStatus(snapshot, 'en')).toContain(`(baseline 0.60, ${en})`)
    }
    // An unknown verdict token is echoed, not replaced with a label it does not
    // have — a new verdict must remain visible.
    expect(formatStatus(makeSnapshot({ evalSummary: { ...base, verdict: 'inconclusive' } }), 'zh')).toContain('inconclusive')
    // Absent aggregate / baseline / verdict → 0-1 as n/a, never a fabricated 0.
    const bare = formatStatus(makeSnapshot({ evalSummary: { ...base } }), 'zh')
    expect(bare).toContain('最近 n/a（基线 n/a，n/a）')
    expect(bare).toContain('历史 3 次')
    expect(formatStatus(makeSnapshot({ evalSummary: { ...base } }), 'en')).toContain('Eval: latest n/a')
    // No summary at all → no eval line, so an unmeasured host is unchanged.
    expect(formatStatus(makeSnapshot(), 'zh')).not.toContain('评测:')
  })

  it('renders a selection line with no runs and no score', () => {
    const stats = {
      ...makeSnapshot().stats,
      selectRuns: 0, selectGains: 0, lastSelectCandidates: 2, lastSelectChosen: 1,
      lastSelectScore: 0, lastSelectGate: 0,
    }
    const zh = formatStatus(makeSnapshot({ stats }), 'zh')
    expect(zh).toContain('（n/a，结构门 0）')
    expect(zh).toContain('累计 0 次择优')
    expect(zh).toContain('（0%）')
    expect(formatStatus(makeSnapshot({ stats }), 'en')).toContain('last 1/2 candidates (n/a, gate 0)')
  })

  it('counts a read session with no judgments without inventing a negative rate', () => {
    const stats = {
      ...makeSnapshot().stats,
      feedbackSessions: 2, feedbackPositive: 0, feedbackNegative: 0, feedbackBiasApplied: 0,
    }
    const zh = formatStatus(makeSnapshot({ stats }), 'zh')
    expect(zh).toContain('宿主反馈: 👍 0 / 👎 0（2 个会话）')
    expect(zh).not.toContain('负面')
    expect(formatStatus(makeSnapshot({ stats }), 'en')).toContain('2 session(s)')
  })

  it('renders events with and without the optional fields', () => {
    const events = [
      { ts: Date.now(), method: 'optimize', ok: true },
      { ts: Date.now(), method: 'iterate', ok: true, local: true, durationMs: 65000 },
      { ts: Date.now(), method: 'optimize', ok: false },
    ]
    const zh = formatStatus(makeSnapshot({ recentEvents: events }), 'zh')
    expect(zh).toMatch(/✅ iterate\s+本地 · 1\.1 分钟/)
    expect(zh).toContain('❌ optimize error')
    expect(formatStatus(makeSnapshot({ recentEvents: events }), 'en')).toContain('✅ iterate ')
    expect(formatStatus(makeSnapshot({ recentEvents: events }), 'en')).toContain(' local · 1.1 min')
    expect(formatStatus(makeSnapshot({ recentEvents: events }), 'en')).toContain('❌ optimize error')
  })

  it('reports the settings panel and auto-adapt state as unavailable when off', () => {
    const zh = formatStatus(makeSnapshot({ settingsPanel: false, autoAdapt: true, minAdaptEpisodes: 5 }), 'zh')
    expect(zh).toContain('自迭代: 开（≥5 次生效）')
    expect(zh).toContain('不可用（走 cordis.patch.yml）')
    const en = formatStatus(makeSnapshot({ settingsPanel: false, autoAdapt: false }), 'en')
    expect(en).toContain('Auto-adapt: off')
    expect(en).toContain('unavailable (cordis.patch.yml)')
  })
})

describe('formatStatus with no measured usage', () => {
  const empty = () => makeSnapshot({
    stats: {
      ...makeSnapshot().stats,
      runs: 0,
      success: 0,
      failed: 0,
      cached: 0,
      local: 0,
      refined: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      lastOutputTokens: 0,
      lastCallMs: 0,
      avgCallMs: 0,
      maxCallMs: 0,
      totalCallMs: 0,
      callCount: 0,
      lastRunCalls: 0,
      lastInputTokens: 0,
      usageCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      lastRunUsage: null,
      lastRunRoute: null,
      selectRuns: 0,
      selectGains: 0,
      lastSelectCandidates: 1,
      lastSelectChosen: 0,
      lastSelectScore: 0,
      lastSelectGate: 0,
      feedbackSessions: 0,
      feedbackPositive: 0,
      feedbackNegative: 0,
    },
    settingsPanel: false,
  })

  it('reports the unmeasured path when the adapter never reported usage', () => {
    const zh = formatStatus(empty(), 'zh')
    expect(zh).toContain('适配器未上报 usage')
    const en = formatStatus(empty(), 'en')
    expect(en).toContain('adapter reported no usage')
    expect(en).toContain('unavailable (cordis.patch.yml)')
  })

  it('reports a 0% cache hit when usage was reported but nothing was billed', () => {
    const base = empty()
    const snapshot = makeSnapshot({
      stats: { ...base.stats, usageCalls: 2, lastRunUsage: null, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      settingsPanel: false,
    })
    const zh = formatStatus(snapshot, 'zh')
    expect(zh).toContain('缓存命中 0%')
    // No last-run usage -> the per-run clause is omitted, not printed as zeros.
    expect(zh).not.toContain('上一次')
    const en = formatStatus(snapshot, 'en')
    expect(en).toContain('Cache hit 0%')
    expect(en).not.toContain('Real usage: cumulative input 0 (cache read 0 / write 0 / uncached 0) ｜ output 0\n  undefined')
  })

  it('prints 0 calls per optimization when nothing ran', () => {
    const zh = formatStatus(empty(), 'zh')
    expect(zh).toContain('平均调用 0 次/次优化')
    const en = formatStatus(empty(), 'en')
    expect(en).toContain('Avg calls 0/run')
  })
})
