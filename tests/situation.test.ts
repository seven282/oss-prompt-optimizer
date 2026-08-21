import { describe, expect, it } from 'vitest'
import {
  archetypeLabel,
  buildSituationProfile,
  detectMeasurable,
  detectTaskSubtype,
  extractMainVerbObject,
  goalAlignment,
  goalAnchors,
  goalDrift,
  mergeGoals,
  normalizeInstruction,
  heuristicClassifier,
  renderSituationBlock,
  SITUATION_PROFILE_VERSION,
  subtypeLabel,
} from '../src/situation.js'

describe('buildSituationProfile — role', () => {
  it('extracts an explicit Chinese role clause with expertise', () => {
    const profile = buildSituationProfile('你是一名资深产品经理，帮我写一份 PRD。')
    expect(profile.role.explicit).toBe('你是一名资深产品经理')
    expect(profile.role.expertise).toBe('资深')
    expect(profile.role.confidence).toBeGreaterThanOrEqual(4)
  })

  it('extracts an explicit English role clause', () => {
    const profile = buildSituationProfile('Act as a senior engineer and refactor the module.')
    expect(profile.role.explicit).toContain('senior engineer')
    expect(profile.role.expertise).toBe('senior')
  })

  it('infers the archetype from the task category', () => {
    const profile = buildSituationProfile('帮我写一封英文邮件')
    expect(profile.role.archetype).toBe('writing')
  })

  it('keeps confidence low for generic inputs (no direct role signal)', () => {
    const profile = buildSituationProfile('帮我写一份周报')
    // archetype alone (writing) scores 1 — below the role-injection gate of 2.
    expect(profile.role.explicit).toBeUndefined()
    expect(profile.role.confidence).toBe(1)
  })
})

describe('buildSituationProfile — task', () => {
  it('fills the coarse task type', () => {
    expect(buildSituationProfile('修复登录页面的 bug').task.type).toBe('code')
    expect(buildSituationProfile('你好').task.type).toBe('other')
  })
})

describe('buildSituationProfile — goal', () => {
  it('extracts the goal sentence and constraint clauses', () => {
    const profile = buildSituationProfile('目标是生成一份周报，不要超过500字，必须包含进展与风险。')
    expect(profile.goal.primary).toBe('目标是生成一份周报')
    expect(profile.goal.constraints).toEqual(['不要超过500字', '必须包含进展与风险'])
  })

  it('extracts nothing when the instruction carries no explicit goal', () => {
    const profile = buildSituationProfile('帮我写一份周报')
    expect(profile.goal.primary).toBeUndefined()
    expect(profile.goal.constraints).toEqual([])
  })
})

describe('goalAnchors', () => {
  it('extracts digits and content tokens, stripping modals and particles', () => {
    expect(goalAnchors('不要超过500字')).toContain('500')
    const anchors = goalAnchors('目标是生成一份周报')
    expect(anchors).toContain('周报')
    expect(anchors).toContain('生成')
  })
})

describe('goalAlignment', () => {
  const goal = { primary: '目标是生成一份周报', constraints: ['不要超过500字'], successCriteria: [] }

  it('passes when the output keeps the goal and every constraint', () => {
    const result = goalAlignment(goal, '输出一份周报，全文 500 字以内，内容简洁。')
    expect(result.aligned).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('reports a dropped constraint', () => {
    const result = goalAlignment(goal, '输出一份周报。')
    expect(result.aligned).toBe(false)
    expect(result.missing).toEqual(['约束：不要超过500字'])
  })

  it('reports a dropped goal', () => {
    const result = goalAlignment(goal, '输出 500 字以内的总结。')
    expect(result.aligned).toBe(false)
    expect(result.missing.some((m) => m.startsWith('目标：'))).toBe(true)
  })
})

describe('renderSituationBlock', () => {
  it('renders nothing for a generic instruction (below the role gate, no goal)', () => {
    expect(renderSituationBlock(buildSituationProfile('帮我写一份周报'), false)).toBe('')
  })

  it('renders the goal and constraints when present (zh)', () => {
    const block = renderSituationBlock(buildSituationProfile('目标是生成一份周报，不要超过500字'), false)
    expect(block).toContain('情境画像')
    expect(block).toContain('目标：目标是生成一份周报')
    expect(block).toContain('约束：不要超过500字')
  })

  it('renders the explicit role when the confidence gate passes (zh)', () => {
    const block = renderSituationBlock(buildSituationProfile('你是一名资深产品经理，帮我写 PRD。'), false)
    expect(block).toContain('角色：你是一名资深产品经理')
  })

  it('renders the English block', () => {
    const block = renderSituationBlock(buildSituationProfile('The goal is to write a report within 500 words.'), true)
    expect(block).toContain('Situation profile')
    expect(block).toContain('Goal:')
  })

  it('keeps the archetype label mapping', () => {
    expect(archetypeLabel('code', false)).toBe('资深工程师/架构师')
    expect(archetypeLabel('analysis', true)).toBe('analyst / researcher')
    expect(archetypeLabel('other', false)).toBeUndefined()
  })
})

describe('detectTaskSubtype (two-level classification)', () => {
  it('classifies coding subcategories', () => {
    expect(detectTaskSubtype('修复登录页面的 bug', 'code')).toBe('code-bugfix')
    expect(detectTaskSubtype('实现用户注册新功能', 'code')).toBe('code-feature')
    expect(detectTaskSubtype('重构订单模块', 'code')).toBe('code-refactor')
    expect(detectTaskSubtype('帮我写个批量处理脚本', 'code')).toBe('code-script')
  })

  it('classifies with added synonyms and normalization (1.4.8)', () => {
    expect(detectTaskSubtype('程序出错了，帮忙看看', 'code')).toBe('code-bugfix')
    expect(detectTaskSubtype('开发一个订单导出功能', 'code')).toBe('code-feature')
    expect(detectTaskSubtype('写一篇周报', 'writing')).toBe('writing-report')
  })

  it('classifies writing subcategories', () => {
    expect(detectTaskSubtype('写一封英文邮件', 'writing')).toBe('writing-email')
    expect(detectTaskSubtype('写一篇周报', 'writing')).toBe('writing-report')
    expect(detectTaskSubtype('把这段翻译成英文', 'writing')).toBe('writing-translate')
    expect(detectTaskSubtype('写一个公众号文案', 'writing')).toBe('writing-copy')
    expect(detectTaskSubtype('帮我润色这段文字', 'writing')).toBe('writing-polish')
    expect(detectTaskSubtype('写一份求职简历', 'writing')).toBe('writing-resume')
    expect(detectTaskSubtype('帮我写个演讲讲稿', 'writing')).toBe('writing-speech')
    expect(detectTaskSubtype('写一篇新闻稿', 'writing')).toBe('writing-copy')
  })

  it('classifies analysis and ops subcategories', () => {
    expect(detectTaskSubtype('分析销售数据趋势', 'analysis')).toBe('analysis-data')
    expect(detectTaskSubtype('把服务部署上线', 'ops')).toBe('ops-deploy')
    expect(detectTaskSubtype('排查线上故障', 'ops')).toBe('ops-troubleshoot')
  })

  it('returns undefined for other or unmatched input', () => {
    expect(detectTaskSubtype('你好', 'other')).toBeUndefined()
    expect(detectTaskSubtype('随便聊聊', 'writing')).toBeUndefined()
  })

  it('fills the subtype into the profile and exposes labels', () => {
    expect(buildSituationProfile('修复登录页面的 bug').task.subtype).toBe('code-bugfix')
    expect(subtypeLabel('code-bugfix', false)).toBe('bug 修复')
    expect(subtypeLabel('code-bugfix', true)).toBe('bug fix')
  })
})

describe('detectMeasurable', () => {
  it('detects quantities, units and deadlines', () => {
    expect(detectMeasurable('写一份不超过 500 字的周报')).toBe(true)
    expect(detectMeasurable('给出 3 个方案')).toBe(true)
    expect(detectMeasurable('明天中午前完成')).toBe(true)
    expect(detectMeasurable('Write a report within 500 words')).toBe(true)
  })

  it('returns false for non-measurable instructions', () => {
    expect(detectMeasurable('帮我写一份周报')).toBe(false)
    expect(detectMeasurable('你好')).toBe(false)
  })
})

describe('goalDrift', () => {
  const goal = (primary?: string, constraints: string[] = []) => ({ primary, constraints, successCriteria: [] })

  it('reports unchanged when both goals match', () => {
    expect(goalDrift(goal('目标是生成一份周报', ['不要超过500字']), goal('目标是生成一份周报', ['不要超过500字']))).toBe('unchanged')
    expect(goalDrift(goal(), goal())).toBe('unchanged')
  })

  it('reports added when the new instruction introduces anchors', () => {
    expect(goalDrift(goal('目标是生成一份周报'), goal('目标是生成一份周报', ['至少500字']))).toBe('added')
  })

  it('reports dropped when previous anchors are lost', () => {
    expect(goalDrift(goal('目标是生成一份周报', ['不要超过500字']), goal('目标是生成一份周报'))).toBe('dropped')
  })

  it('reports modified when the primary text changes without an anchor shift', () => {
    expect(goalDrift(goal('目标是生成周报'), goal('目标是生成周报！'))).toBe('modified')
  })
})

describe('buildSituationProfile — capability/behavior (P1 角色三要素抽取)', () => {
  it('extracts a capability clause and lets it pass the injection gate alone', () => {
    const profile = buildSituationProfile('精通 Python 和 SQL，擅长可视化，把需求整理为方案')
    expect(profile.role.explicit).toBeUndefined()
    expect(profile.role.capability).toContain('精通 Python')
    expect(profile.role.confidence).toBeGreaterThanOrEqual(2)
    expect(renderSituationBlock(profile, false)).toContain('能力：精通 Python')
  })

  it('extracts an English capability clause', () => {
    const profile = buildSituationProfile('Proficient in Python and SQL, refactor the module.')
    expect(profile.role.capability).toContain('Proficient in')
  })

  it('extracts a behavior rule clause (先给…/避免…)', () => {
    expect(buildSituationProfile('先给结论再补充细节。').role.behavior).toBe('先给结论再补充细节')
    expect(buildSituationProfile('避免使用专业术语。').role.behavior).toBe('避免使用专业术语')
  })

  it('does not treat goal constraints as role behavior', () => {
    const profile = buildSituationProfile('目标是生成一份周报，不要超过500字，必须包含进展与风险。')
    expect(profile.role.behavior).toBeUndefined()
    expect(profile.goal.constraints).toEqual(['不要超过500字', '必须包含进展与风险'])
  })

  it('extracts a scene-style identity (以…的身份 / acting as…) into explicit', () => {
    const zh = buildSituationProfile('以产品经理的身份评审这个需求')
    expect(zh.role.explicit).toBe('以产品经理的身份')
    const en = buildSituationProfile('Acting as a senior reviewer, assess this design.')
    expect(en.role.explicit).toContain('senior reviewer')
  })

  it('renders identity + capability + behavior together in the role block', () => {
    const block = renderSituationBlock(buildSituationProfile('你是数据科学家，精通 Python，先给结论再补充细节。'), false)
    expect(block).toContain('角色：你是数据科学家')
    expect(block).toContain('能力：精通 Python')
    expect(block).toContain('行为：先给结论')
  })
})

describe('conversation role cues (context fallback)', () => {
  it('uses a role clause from context when the instruction has none', () => {
    const profile = buildSituationProfile('把这段翻译成英文', '你是我的翻译，风格偏商务。')
    expect(profile.role.explicit).toContain('翻译')
    expect(profile.role.confidence).toBeGreaterThanOrEqual(2)
  })

  it('keeps the instruction role over the context role', () => {
    const profile = buildSituationProfile('你是一名产品经理，写 PRD', '你是我的翻译。')
    expect(profile.role.explicit).toBe('你是一名产品经理')
  })
})

describe('profile memoization', () => {
  it('returns the same instance for an identical (input, context) pair', () => {
    const a = buildSituationProfile('目标是生成一份周报', '背景')
    const b = buildSituationProfile('目标是生成一份周报', '背景')
    expect(a).toBe(b)
    expect(buildSituationProfile('目标是生成一份周报', '不同背景')).not.toBe(a)
  })
})

describe('renderSituationBlock drift', () => {
  it('appends the drift line when a non-unchanged drift is given (zh)', () => {
    const profile = buildSituationProfile('目标是生成一份周报')
    const block = renderSituationBlock(profile, false, 'added')
    expect(block).toContain('相对上次结果：新指令新增了目标/约束要求')
  })

  it('omits the drift line for unchanged', () => {
    const block = renderSituationBlock(buildSituationProfile('目标是生成一份周报'), false, 'unchanged')
    expect(block).not.toContain('相对上次结果')
  })
})

describe('profile schema versioning (P2)', () => {
  it('carries the current version on every profile', () => {
    expect(SITUATION_PROFILE_VERSION).toBe(2)
    expect(buildSituationProfile('目标是生成一份周报').version).toBe(SITUATION_PROFILE_VERSION)
  })
})

describe('mergeGoals (P2 session registry semantics)', () => {
  const goal = (primary?: string, constraints: string[] = []) => ({ primary, constraints, successCriteria: [] })

  it('fills the primary goal from the registry when the current instruction has none', () => {
    expect(mergeGoals(goal('目标是生成一份周报', ['不要超过500字']), goal(undefined, []))).toEqual({
      primary: '目标是生成一份周报',
      constraints: ['不要超过500字'],
      successCriteria: [],
    })
  })

  it('lets the current instruction win when it states a goal or constraints', () => {
    expect(mergeGoals(goal('旧目标', ['旧约束']), goal('新目标', ['新约束']))).toEqual({
      primary: '新目标',
      constraints: ['新约束'],
      successCriteria: [],
    })
  })

  it('does not resurrect old constraints once the current instruction states its own', () => {
    const merged = mergeGoals(goal('目标是生成一份周报', ['不要超过500字']), goal(undefined, ['至少300字']))
    expect(merged.constraints).toEqual(['至少300字'])
  })
})

describe('renderSituationBlock level gate (P2 situationProfileLevel)', () => {
  const roleProfile = buildSituationProfile('你是一名资深产品经理，目标是生成一份周报，不要超过500字')

  it('renders everything at full (default)', () => {
    const block = renderSituationBlock(roleProfile, false)
    expect(block).toContain('角色：你是一名资深产品经理')
    expect(block).toContain('目标：')
    expect(block).toContain('约束：')
  })

  it('renders goal/constraints only at minimal (no role signals)', () => {
    const block = renderSituationBlock(roleProfile, false, undefined, 'minimal')
    expect(block).toContain('目标：')
    expect(block).not.toContain('角色：')
  })

  it('renders nothing at off', () => {
    expect(renderSituationBlock(roleProfile, false, undefined, 'off')).toBe('')
  })
})

describe('normalizeInstruction + extractMainVerbObject (1.4.8)', () => {
  it('normalizes full-width and case', () => {
    expect(normalizeInstruction('Ｗｒｉｔｅ  Ａ　Ｂｏｏｋ')).toBe('write a book')
  })

  it('extracts verb + object (zh)', () => {
    expect(extractMainVerbObject('帮我写一份周报')).toEqual({ verb: '写', object: '一份周报' })
    expect(extractMainVerbObject('请翻译这段文字')).toEqual({ verb: '翻译', object: '这段文字' })
  })

  it('extracts verb + object (en)', () => {
    expect(extractMainVerbObject('Write a Python script to parse CSV')).toEqual({ verb: 'write', object: 'a python script to parse csv' })
  })

  it('stays empty for low-confidence inputs (no known verb)', () => {
    expect(extractMainVerbObject('今天天气怎么样')).toBeUndefined()
  })

  it('injects the core action only alongside other signals', () => {
    const profile = buildSituationProfile('目标是生成一份周报，请帮我写一份')
    const block = renderSituationBlock(profile, false)
    expect(block).toContain('核心动作：写')
    // 无角色/目标信号的 generic 指令仍不渲染（ADR-009 零注入）
    expect(renderSituationBlock(buildSituationProfile('周报'), false)).toBe('')
  })
})

describe('heuristicClassifier (ADR-011 step 1-2)', () => {
  it('classifies with confidence and subtype', () => {
    const r = heuristicClassifier.classify('帮我修复登录页面的 bug')
    expect(r.type).toBe('code')
    expect(r.subtype).toBe('code-bugfix')
    expect(r.confidence).toBeGreaterThan(0.5)
  })

  it('returns a low-confidence `other` for generic input', () => {
    const r = heuristicClassifier.classify('今天天气怎么样')
    expect(r.type).toBe('other')
    expect(r.confidence).toBeLessThan(0.5)
  })

  it('boosts confidence when the main verb-object is found', () => {
    const withVerb = heuristicClassifier.classify('帮我写一份周报').confidence
    const without = heuristicClassifier.classify('周报').confidence
    expect(withVerb).toBeGreaterThan(without)
  })
})

describe('writing-presentation subtype (1.6.4)', () => {
  it('detects PPT/presentation instructions', () => {
    expect(detectTaskSubtype('帮我生成个人介绍PPT', 'writing')).toBe('writing-presentation')
    expect(detectTaskSubtype('做一个述职汇报PPT', 'writing')).toBe('writing-presentation')
    expect(detectTaskSubtype('生成演示文稿', 'writing')).toBe('writing-presentation')
  })

  it('does not steal speech or report scenarios', () => {
    // 演示稿（讲稿向）→ speech；纯汇报（无 PPT 语境）→ report。
    expect(detectTaskSubtype('帮我写个演讲讲稿', 'writing')).toBe('writing-speech')
    expect(detectTaskSubtype('帮我写个汇报', 'writing')).toBe('writing-report')
  })
})
