import { describe, expect, it } from 'vitest'
import { buildLocalTemplate, buildRefinePrompt, goalAnchorsScore, goalRichness, localTemplateGate } from '../src/local.js'
import { buildSituationProfile } from '../src/situation.js'

describe('localTemplateGate (1.5.6)', () => {
  it('passes a structured subcategory with extractable signals in auto mode', () => {
    const g = localTemplateGate('写一份周报，总结本周进展和下周计划', 'auto')
    expect(g.ok).toBe(true)
    expect(g.reason).toBe('pass')
    expect(g.subtype).toBe('writing-report')
  })

  it('rejects a bare category without signals in auto mode (no-signal)', () => {
    // 命中 writing 大类但子类不明确 / 无信号 → 回落 LLM。
    const g = localTemplateGate('帮我写个东西', 'auto')
    expect(g.ok).toBe(false)
    expect(['no-subtype', 'no-signal', 'other-task']).toContain(g.reason)
  })

  it('rejects open-ended subcategories (creative) in auto and on modes', () => {
    const g = localTemplateGate('写一首诗，关于秋天', 'on')
    expect(g.ok).toBe(false)
    expect(g.reason).toBe('open-creative')
  })

  it('on mode passes a bare category match without signals', () => {
    const g = localTemplateGate('帮我写周报', 'on')
    expect(g.ok).toBe(true)
    expect(g.subtype).toBe('writing-report')
  })

  it('off mode never passes', () => {
    const g = localTemplateGate('写一份周报', 'off')
    expect(g.ok).toBe(false)
    expect(g.reason).toBe('off')
  })

  it('auto mode passes with conversation context even without other signals', () => {
    const g = localTemplateGate('写周报', 'auto', '第一轮：明确了目标，第二轮：补充了数据')
    expect(g.ok).toBe(true)
  })
})

describe('goal-aware scores (1.6.1 hybrid)', () => {
  it('scores goal anchors from the situation profile', () => {
    // 数据分析指令：目标/约束锚点（结论先行、200 字）≥ 0.4 → hybrid 直出。
    const rich = buildSituationProfile('你是资深数据分析师，分析这份销售数据的趋势，结论先行，不超过 200 字')
    expect(goalAnchorsScore(rich)).toBeGreaterThanOrEqual(0.4)
    // 裸周报指令：无目标/约束/受众/角色锚点 → 0 → hybrid 精修。
    const bare = buildSituationProfile('写一份周报，总结本周进展和下周计划')
    expect(goalAnchorsScore(bare)).toBe(0)
  })

  it('scores goal richness higher than bare anchors', () => {
    const bare = buildSituationProfile('写一份周报，总结本周进展和下周计划')
    const rich = buildSituationProfile('你是资深数据分析师，分析这份销售数据的趋势，结论先行，不超过 200 字')
    expect(goalRichness('写一份周报，总结本周进展和下周计划', bare)).toBeGreaterThan(0)
    expect(goalRichness('你是资深数据分析师，分析这份销售数据的趋势，结论先行，不超过 200 字', rich))
      .toBeGreaterThan(goalRichness('写一份周报，总结本周进展和下周计划', bare))
  })

  it('carries confidence on gate pass results', () => {
    const g = localTemplateGate('你是资深数据分析师，分析这份销售数据的趋势，结论先行，不超过 200 字', 'auto')
    expect(g.ok).toBe(true)
    expect(g.confidence).toBeGreaterThan(0)
  })

  it('builds a cheap refinement prompt from the local render and the instruction', () => {
    const p = buildRefinePrompt('## Role\n资深撰稿人', '写一份周报', false)
    expect(p).toContain('本地生成结果')
    expect(p).toContain('原始指令')
    expect(p).toContain('## Role\n资深撰稿人')
    const en = buildRefinePrompt('## Role\nWriter', 'write a report', true)
    expect(en).toContain('Locally generated result')
    expect(en).toContain('Original instruction')
  })
})

describe('buildLocalTemplate (1.5.6)', () => {
  it('renders a four-section template with role/task/context/format', () => {
    const out = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    expect(out).toContain('## Role')
    expect(out).toContain('## Task')
    expect(out).toContain('## Context')
    expect(out).toContain('## Format')
    // Role 来自角色库（无显式角色时）。
    expect(out).not.toContain('{{')
  })

  it('uses the explicit role when the instruction names one', () => {
    const out = buildLocalTemplate('你是资深数据分析师，分析这份销售数据的趋势', 'analysis-data', 'zh')
    expect(out).toContain('资深数据分析师')
  })

  it('renders English templates with en metaLanguage', () => {
    const out = buildLocalTemplate('Write a weekly report summarizing this week', 'writing-report', 'en')
    expect(out).toContain('## Role')
    expect(out).toContain('## Task')
  })

  it('renders deterministically for the same input', () => {
    const a = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    const b = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    expect(a).toBe(b)
  })

  it('strips internal prefixes and meta markers from the rendered sections (P0 净化)', () => {
    const out = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    // Role: no "角色参考：" internal prefix.
    expect(out).not.toContain('角色参考：')
    // Task: no "场景骨架：" skeleton dump nor the "（来自原始指令）" marker.
    expect(out).not.toContain('场景骨架：')
    expect(out).not.toContain('来自原始指令')
    // Format: no "Format " label leak.
    expect(out).not.toContain('\nFormat 标题')
    // Finished reading: role reads as a product, task carries the extracted verb.
    expect(out).toContain('资深撰稿人，擅长公文/营销/技术写作')
    expect(out).toContain('核心动作：写「一份周报」')
  })

  it('keeps the explicit role and audience context when present', () => {
    const out = buildLocalTemplate('你是资深数据分析师，分析这份销售数据的趋势', 'analysis-data', 'zh')
    expect(out).toContain('资深数据分析师')
    expect(out).not.toContain('角色参考：')
  })

  it('enriches role and context from the subtype fill rules (P1 丰富度)', () => {
    // 周报 → Role 追加「结论先行、要点支撑…」，Context 有「面向汇报对象…」，
    // 不再落到「无额外背景」空兜底。
    const out = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    expect(out).toContain('结论先行、要点支撑、按文体控制篇幅')
    expect(out).toContain('面向汇报对象，聚焦进展与待办')
    expect(out).not.toContain('无额外背景')
  })

  it('renders the English fill-rule enrichment with the right separator', () => {
    const out = buildLocalTemplate('Write a weekly report summarizing this week', 'writing-report', 'en')
    expect(out).toContain('lead with the conclusion, back with points, match length to the genre')
    expect(out).toContain('focus on progress and next steps for the audience.')
  })
})
