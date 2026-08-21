import { describe, expect, it } from 'vitest'
import { buildLocalTemplate, localTemplateGate } from '../src/local.js'

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
})
