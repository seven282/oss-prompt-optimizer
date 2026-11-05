import { describe, expect, it } from 'vitest'
import { buildLocalTemplate, buildRefinePrompt, goalAnchorsScore, localTemplateGate } from '../src/local.js'
import { toRoleTaskGoal } from '../src/validate.js'
import { buildSituationProfile, SITUATION_PROFILE_VERSION, type SituationProfile } from '../src/situation.js'

describe('localTemplateGate (1.5.6)', () => {
  it('passes a structured subcategory with extractable signals in hybrid mode', () => {
    const g = localTemplateGate('写一份周报，总结本周进展和下周计划', 'hybrid')
    expect(g.ok).toBe(true)
    expect(g.reason).toBe('pass')
    expect(g.subtype).toBe('writing-report')
  })

  it('rejects a bare category without signals in hybrid mode (no-signal)', () => {
    // 命中 writing 大类但子类不明确 / 无信号 → 回落 LLM。
    const g = localTemplateGate('帮我写个东西', 'hybrid')
    expect(g.ok).toBe(false)
    expect(['no-subtype', 'no-signal', 'other-task']).toContain(g.reason)
  })

  it('rejects open-ended subcategories (creative) in hybrid and on modes', () => {
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

  it('hybrid mode passes with conversation context even without other signals', () => {
    const g = localTemplateGate('写周报', 'hybrid', '第一轮：明确了目标，第二轮：补充了数据')
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

  it('builds a seed-optimization prompt from the local render, instruction, and goal anchors', () => {
    const p = buildRefinePrompt('## Role\n资深撰稿人', '写一份周报', false)
    expect(p).toContain('本地参考模板')
    expect(p).toContain('原始指令')
    expect(p).toContain('## Role\n资深撰稿人')
    const en = buildRefinePrompt('## Role\nWriter', 'write a report', true)
    expect(en).toContain('Locally generated reference template')
    expect(en).toContain('Original instruction')
    // 1.6.2：传入 profile 时注入目标画像块（目标/约束/受众锚点）。
    const rich = buildSituationProfile('你是资深数据分析师，分析这份销售数据的趋势，结论先行，不超过 200 字')
    const withProfile = buildRefinePrompt('## Role\n资深数据分析师', '分析这份销售数据的趋势，结论先行，不超过 200 字', false, rich)
    expect(withProfile).toContain('目标与约束（优化时须保留并补全）')
    expect(withProfile).toContain('约束：')
    // 诊断注入（目标对齐重试路径）。
    const withDiag = buildRefinePrompt('## Role\n资深数据分析师', '分析这份销售数据的趋势', false, rich, 'missing: 约束：结论先行')
    expect(withDiag).toContain('上一次输出未体现以下目标/约束')
  })
})

describe('buildLocalTemplate (1.5.6)', () => {
  it('renders a plain-text template without section headers', () => {
    const out = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    // No section headers in plain mode.
    expect(out).not.toContain('## Role')
    expect(out).not.toContain('## Task')
    expect(out).not.toContain('## Context')
    expect(out).not.toContain('## Format')
    // Role 来自角色库（无显式角色时）。
    expect(out).not.toContain('{{')
  })

  it('uses the explicit role when the instruction names one', () => {
    const out = buildLocalTemplate('你是资深数据分析师，分析这份销售数据的趋势', 'analysis-data', 'zh')
    expect(out).toContain('资深数据分析师')
  })

  it('renders English templates with en metaLanguage', () => {
    const out = buildLocalTemplate('Write a weekly report summarizing this week', 'writing-report', 'en')
    expect(out).not.toContain('## Role')
    expect(out).not.toContain('## Task')
  })

  it('renders deterministically for the same input', () => {
    const a = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    const b = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    expect(a).toBe(b)
  })

  it('strips internal prefixes and meta markers from the rendered output (P0 净化)', () => {
    const out = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    // Role: no "角色参考：" internal prefix.
    expect(out).not.toContain('角色参考：')
    // Task: no "场景骨架：" skeleton dump nor the "（来自原始指令）" marker.
    expect(out).not.toContain('场景骨架：')
    expect(out).not.toContain('来自原始指令')
    // Format: no "Format " label leak.
    expect(out).not.toContain('\nFormat 标题')
    // Finished reading: role and task read as complete, professional prompts.
    expect(out).toContain('作为资深项目助理，擅长简洁有力的要点式周报')
    expect(out).toContain('撰写周报')
  })

  it('keeps the explicit role and audience context when present', () => {
    const out = buildLocalTemplate('你是资深数据分析师，分析这份销售数据的趋势', 'analysis-data', 'zh')
    expect(out).toContain('资深数据分析师')
    expect(out).not.toContain('角色参考：')
  })

  it('enriches role and context from the subtype fill rules (P1 丰富度)', () => {
    // 周报 → Role 来自 FILL_RULES 四要素成品，Context 含汇报对象与进展待办。
    const out = buildLocalTemplate('写一份周报，总结本周进展和下周计划', 'writing-report', 'zh')
    expect(out).toContain('作为资深项目助理，擅长简洁有力的要点式周报')
    expect(out).toContain('面向团队与管理层，聚焦进度与待办')
  })

  it('renders the English fill-rule enrichment with the right content', () => {
    const out = buildLocalTemplate('Write a weekly report summarizing this week', 'writing-report', 'en')
    expect(out).toContain('As a senior project assistant skilled in concise point-form weekly reports')
    expect(out).toContain('For the team and management')
  })
})

describe('writing-presentation local render (1.6.4)', () => {
  it('renders a presentation-oriented template with fill rules', () => {
    const out = buildLocalTemplate('帮我生成个人介绍PPT', 'writing-presentation', 'zh')
    expect(out).not.toContain('## Role')
    expect(out).toContain('演示内容架构师')
    expect(out).not.toContain('## Task')
    expect(out).toContain('明确受众与目的')
    expect(out).not.toContain('## Format')
    expect(out).toContain('内容框架 + 页面结构 + 设计建议 + 演示话术')
  })
})

describe('role-task-goal local fold (1.6.5)', () => {
  it('folds a four-section render into Role/Task/Goal labels', () => {
    const four = '## Role\n资深数据分析师。\n\n## Task\n分析销售数据并输出报告。\n\n## Context\n面向业务决策者。\n\n## Format\n不超过 500 字。'
    const zh = toRoleTaskGoal(four, false)
    expect(zh).toContain('角色：\n资深数据分析师')
    expect(zh).toContain('任务：\n分析销售数据并输出报告')
    expect(zh).toContain('目标：\n面向业务决策者。；不超过 500 字。')
    const en = toRoleTaskGoal(four, true)
    expect(en).toContain('Role:' + '\n' + '资深数据分析师')
    expect(en).toContain('Goal:' + '\n' + '面向业务决策者。 不超过 500 字。')
  })

  it('builds the refine prompt with the RTG shape rule', () => {
    const p = buildRefinePrompt('## Role\nx', '写周报', false, undefined, undefined, 'role-task-goal')
    expect(p).toContain('只输出三行标签——角色：、任务：、目标：')
    const s = buildRefinePrompt('## Role\nx', 'weekly report', true, undefined, undefined, 'sections')
    expect(s).toContain('Keep the ## Role / ## Task / ## Context / ## Format structure')
  })
})

describe('local branch matrix', () => {
  it('scores goal anchors that carry only constraints or only a role', () => {
    const constraintsOnly = {
      goal: { constraints: ['预算 5 万'] },
      role: {},
      task: { type: 'writing' },
    } as never
    expect(goalAnchorsScore(constraintsOnly)).toBeCloseTo(0.3)

    const roleOnly = {
      goal: { constraints: [] },
      role: { audience: 'CTO' },
      task: { type: 'writing' },
    } as never
    expect(goalAnchorsScore(roleOnly)).toBeCloseTo(0.2)

    const explicitRole = {
      goal: { constraints: [] },
      role: { explicit: '资深分析师' },
      task: { type: 'writing' },
    } as never
    expect(goalAnchorsScore(explicitRole)).toBeCloseTo(0.1)
  })

  it('gates on each usable signal independently in hybrid mode', () => {
    // A blank context is NOT a signal: whitespace must not turn a bare
    // category into a local render.
    expect(localTemplateGate('翻译', 'hybrid', '   ').ok).toBe(false)
    // A measurable requirement on its own is.
    const measurable = localTemplateGate('翻译 300 字以内的产品说明', 'hybrid')
    expect(measurable.ok).toBe(true)
    expect(measurable.subtype).toBeDefined()
  })

  it('refuses an unknown subcategory and echoes the instruction instead', () => {
    expect(buildLocalTemplate('原始指令', 'no-such-subtype')).toBe('原始指令')
  })

  it('folds audience, goal, constraints, measurable and context into the render', () => {
    const zh = buildLocalTemplate('帮我写周报，面向 CTO，不超过 500 字', 'writing-report', 'zh')
    expect(zh).toContain('面向')
    expect(zh).toContain('需满足可量化要求')
    const withContext = buildLocalTemplate('帮我写周报', 'writing-report', 'en', '上周讨论过预算')
    expect(withContext).toContain('Conversation context: 上周讨论过预算')
    // A blank context contributes nothing.
    expect(buildLocalTemplate('帮我写周报', 'writing-report', 'en', '   ')).not.toContain('Conversation context')
  })

  it('renders the refine prompt with and without goal anchors, diagnosis and RTG shape', () => {
    const profile = buildSituationProfile('帮我写周报，面向 CTO，预算 5 万，3 天内交给老板')
    const zh = buildRefinePrompt('本地骨架', '帮我写周报', false, profile)
    expect(zh).toContain('目标与约束（优化时须保留并补全）')
    const en = buildRefinePrompt('local seed', 'write a report', true, profile)
    expect(en).toContain('Goal anchors to keep and complete')
    // No profile → no anchor block at all.
    expect(buildRefinePrompt('seed', 'x', false)).not.toContain('目标与约束')
    // A diagnosis is appended when present, skipped when empty.
    expect(buildRefinePrompt('seed', 'x', false, profile, '缺少受众')).toContain('上一次输出未体现')
    expect(buildRefinePrompt('seed', 'x', false, profile, '')).not.toContain('上一次输出未体现')
    expect(buildRefinePrompt('seed', 'x', true, profile, undefined, 'role-task-goal')).toContain('Role:, Task:, Goal:')
    expect(buildRefinePrompt('seed', 'x', false, profile, undefined, 'role-task-goal')).toContain('只输出三行标签')
  })
})

describe('local render matrix', () => {
  it('scores a profile that states a primary goal', () => {
    const profile = buildSituationProfile('帮我写周报，目标是覆盖本周三个项目的进展与风险')
    expect(goalAnchorsScore(profile)).toBeGreaterThan(0)
  })

  it('renders the English audience, measurable and context lines from an English instruction', () => {
    const en = buildLocalTemplate('Write a report targeting busy CTOs, 500 words max', 'writing-report', 'en', 'we discussed the rollout')
    expect(en).toContain('Audience: busy CTOs')
    expect(en).toContain('Must meet quantifiable requirements')
    expect(en).toContain('Conversation context: we discussed the rollout')
  })

  it('appends an English diagnosis to the refine prompt', () => {
    const profile = buildSituationProfile('帮我写周报，面向 CTO')
    const en = buildRefinePrompt('seed', 'write a report', true, profile, 'audience')
    expect(en).toContain('the previous attempt missed')
  })

  it('renders a goal sentence into the context block in both languages', () => {
    expect(buildLocalTemplate('帮我写周报，目标是覆盖三个项目进展', 'writing-report', 'zh')).toContain('覆盖三个项目进展')
    expect(buildLocalTemplate('Write a report, the goal is to cover three projects', 'writing-report', 'en')).toContain('three projects')
  })
})

describe('refine and render boundaries', () => {
  it('renders English anchors and skips the goal line when there is none', () => {
    const constrained: SituationProfile = {
      version: SITUATION_PROFILE_VERSION,
      role: { confidence: 1, audience: 'CTO' },
      task: { type: 'writing' },
      goal: { primary: undefined, constraints: ['结论先行'], successCriteria: [] },
    }
    const en = buildRefinePrompt('## Role\nWriter', 'write a weekly report', true, constrained)
    expect(en).toContain('Constraint: 结论先行')
    expect(en).toContain('Audience: CTO')
    expect(en).not.toContain('Goal:')
  })

  it('injects the conversation context into the rendered template', () => {
    const en = buildLocalTemplate('Write a weekly report', 'writing-report', 'en', '  previous round agreed on scope  ')
    expect(en).toContain('Conversation context: previous round agreed on scope')
    const zh = buildLocalTemplate('写一份周报', 'writing-report', 'zh', '上一轮已确认范围')
    expect(zh).toContain('对话背景：上一轮已确认范围')
  })

  it('returns the instruction untouched for an unknown subtype', () => {
    expect(buildLocalTemplate('随便写点', 'nope-unknown', 'zh')).toBe('随便写点')
  })
})
