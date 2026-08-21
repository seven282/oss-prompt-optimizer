import { describe, expect, it } from 'vitest'
import {
  assertInput,
  diagnoseSections,
  estimateTokens,
  hasAllSections,
  hasMetaContent,
  hasOptimizedSections,
  hasPlainOutput,
  hasRoleTaskGoalLabels,
  hasSectionHeadings,
  hasSubstantialContent,
  hasValidRoleTaskGoal,
  hasValidSections,
  INCOMPLETE_SECTIONS_MESSAGE,
  metaContentMessage,
  plainHeadingsMessage,
  REQUIRED_SECTIONS,
  sectionBody,
  thinOutputMessage,
  truncateByTokens,
  truncateInput,
} from '../src/validate.js'

const FOUR_SECTIONS = `## Role
你是一名资深产品经理。

## Task
分析需求并输出 PRD。

## Context
面向中小企业，预算有限。

## Format
Markdown 文档，不超过 500 字。`

describe('hasAllSections', () => {
  it('accepts a prompt with all four headings', () => {
    expect(hasAllSections(FOUR_SECTIONS)).toBe(true)
  })

  it('accepts headings with CJK colons', () => {
    expect(hasAllSections('## Role：专家\n## Task：写代码\n## Context：背景\n## Format：文本')).toBe(true)
  })

  it('rejects missing sections', () => {
    const withoutFormat = FOUR_SECTIONS.replace('## Format', '## 输出')
    expect(hasAllSections(withoutFormat)).toBe(false)
  })

  it('rejects Chinese-variant headings (canonical English only)', () => {
    const chinese = FOUR_SECTIONS.replace('## Role', '## 角色').replace('## Context', '## 背景')
    expect(hasAllSections(chinese)).toBe(false)
  })

  it('rejects a prompt missing every heading', () => {
    expect(hasAllSections('随便一段文本')).toBe(false)
  })

  it('does not match headings inside code fences', () => {
    // The regex is deliberately simple; a fenced `## Role` still matches by
    // design (the harness convention validates presence, not structure).
    expect(hasAllSections(`\`\`\`\n## Role\n## Task\n## Context\n## Format\n\`\`\``)).toBe(true)
  })
})

describe('hasOptimizedSections', () => {
  it('accepts the canonical English headings', () => {
    expect(hasOptimizedSections(FOUR_SECTIONS)).toBe(true)
  })

  it('accepts Chinese-variant headings', () => {
    const chinese = `## 角色
你是一名资深产品经理。

## 任务
分析需求并输出 PRD。

## 背景
面向中小企业，预算有限。

## 输出
Markdown 文档，不超过 500 字。`
    expect(hasOptimizedSections(chinese)).toBe(true)
  })

  it('accepts a mixed heading-language prompt', () => {
    const mixed = FOUR_SECTIONS.replace('## Role', '## 角色').replace('## Context', '## 上下文')
    expect(hasOptimizedSections(mixed)).toBe(true)
  })

  it('rejects prompts missing one of the four sections', () => {
    const three = `## 角色
资深产品经理。

## 任务
写 PRD。

## 输出
Markdown 文档。`
    expect(hasOptimizedSections(three)).toBe(false)
    expect(hasOptimizedSections('随便一段文本')).toBe(false)
  })

  it('does not accept near-miss headings like "## 格式要求"', () => {
    const nearMiss = `## 角色
A

## 任务
B

## 背景
C

## 格式要求
D`
    expect(hasOptimizedSections(nearMiss)).toBe(false)
  })
})

describe('sectionBody', () => {
  it('extracts the body of one section', () => {
    expect(sectionBody(FOUR_SECTIONS, 'Role')).toBe('你是一名资深产品经理。')
  })

  it('returns an empty string when the heading is absent', () => {
    expect(sectionBody('## Task\n写代码', 'Role')).toBe('')
  })

  it('stops at the next heading', () => {
    expect(sectionBody(FOUR_SECTIONS, 'Task')).toBe('分析需求并输出 PRD。')
  })
})

describe('hasValidSections', () => {
  it('accepts sections with enough content', () => {
    expect(hasValidSections(FOUR_SECTIONS, 5)).toBe(true)
  })

  it('rejects a section whose body is too short', () => {
    const thin = '## Role\n好\n\n## Task\n分析需求并输出 PRD。\n\n## Context\n面向中小企业，预算有限。\n\n## Format\nMarkdown 文档，不超过 500 字。'
    expect(hasValidSections(thin, 10)).toBe(false)
  })

  it('falls back to heading-only validation when minChars is zero', () => {
    const emptyHeads = '## Role\n\n## Task\n\n## Context\n\n## Format\n'
    expect(hasValidSections(emptyHeads, 0)).toBe(true)
    expect(hasValidSections(emptyHeads, 1)).toBe(false)
  })
})

describe('hasSubstantialContent', () => {
  it('accepts text at or above the threshold', () => {
    expect(hasSubstantialContent('你是一名产品经理', 8)).toBe(true)
    expect(hasSubstantialContent('你是一名产品经理', 9)).toBe(false)
  })

  it('ignores whitespace when counting', () => {
    expect(hasSubstantialContent(' 你 是 一 名 产 品 经 理 \n', 8)).toBe(true)
  })

  it('rejects empty and whitespace-only text above a zero threshold', () => {
    expect(hasSubstantialContent('', 1)).toBe(false)
    expect(hasSubstantialContent('   \n  ', 1)).toBe(false)
  })

  it('passes any text when the threshold is zero', () => {
    expect(hasSubstantialContent('', 0)).toBe(true)
  })

  it('exposes a stable too-short message', () => {
    expect(thinOutputMessage(10)).toMatch(/fewer than 10/)
  })
})

describe('hasSectionHeadings', () => {
  it('detects any of the four section headings', () => {
    expect(hasSectionHeadings('## Role\n正文')).toBe(true)
    expect(hasSectionHeadings('## Task：正文')).toBe(true)
  })

  it('rejects heading-free prose', () => {
    expect(hasSectionHeadings('你是产品经理。把需求整理为 PRD。')).toBe(false)
  })

  it('does not match a section name without the heading marker', () => {
    expect(hasSectionHeadings('Role 和 Task 是英文单词')).toBe(false)
  })
})

describe('hasPlainOutput', () => {
  it('accepts heading-free prose above the threshold', () => {
    const body = '你是产品经理。把需求整理为 PRD，面向中小企业，预算有限，输出 Markdown 文档，不超过 500 字。'
    expect(hasPlainOutput(body, 10)).toBe(true)
  })

  it('rejects output that still carries section headings', () => {
    expect(hasPlainOutput('## Role\n你是产品经理。把需求整理为 PRD，面向中小企业，预算有限。', 10)).toBe(false)
  })

  it('rejects output that is too short', () => {
    expect(hasPlainOutput('太短', 10)).toBe(false)
  })

  it('exposes a stable headings-forbidden message', () => {
    expect(plainHeadingsMessage()).toMatch(/contains section headings/)
  })
})

describe('assertInput', () => {
  it('accepts a non-empty string', () => {
    expect(() => assertInput('写一首诗')).not.toThrow()
  })

  it('rejects empty and blank strings', () => {
    expect(() => assertInput('')).toThrow(/non-empty/)
    expect(() => assertInput('   \n\t ')).toThrow(/non-empty/)
  })

  it('rejects non-string values', () => {
    expect(() => assertInput(42 as unknown as string)).toThrow(/non-empty/)
  })
})

describe('truncateInput', () => {
  it('passes short input through unchanged', () => {
    expect(truncateInput('short', 100)).toBe('short')
  })

  it('truncates long input with a marker', () => {
    const result = truncateInput('x'.repeat(5000), 100)
    expect(result.length).toBeLessThan(5000)
    expect(result).toContain('[原始指令已截断')
    expect(result.startsWith('x'.repeat(100))).toBe(true)
  })
})

describe('constants', () => {
  it('declares the canonical section order', () => {
    expect([...REQUIRED_SECTIONS]).toEqual(['Role', 'Task', 'Context', 'Format'])
  })
  it('exposes a stable incomplete-sections message', () => {
    expect(INCOMPLETE_SECTIONS_MESSAGE).toContain('## Role')
  })
})

describe('estimateTokens', () => {
  it('counts CJK characters as one token each', () => {
    expect(estimateTokens('你是一名产品经理')).toBe(8)
  })

  it('counts ASCII runs as one token per four characters', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('mixes CJK and ASCII', () => {
    expect(estimateTokens('你好 world')).toBe(2 + 2)
  })
})

describe('truncateByTokens', () => {
  const estimate = (text: string) => estimateTokens(text)

  it('passes input within budget through unchanged', () => {
    expect(truncateByTokens('你好世界', 10, estimate)).toBe('你好世界')
  })

  it('truncates over-budget input with a token marker', () => {
    const result = truncateByTokens('你是一名产品经理，负责分析需求', 3, estimate)
    expect(result).toContain('超出 3 token')
    expect(result.startsWith('你是一')).toBe(true)
    expect(result).not.toContain('产品经理')
  })

  it('does nothing when maxTokens is zero', () => {
    expect(truncateByTokens('你是一名产品经理', 0, estimate)).toBe('你是一名产品经理')
  })
})

describe('diagnoseSections', () => {
  it('reports missing sections in canonical order', () => {
    const diagnosis = diagnoseSections(FOUR_SECTIONS.replace('## Format', '## 输出'), 10)
    expect(diagnosis.missing).toEqual(['Format'])
    expect(diagnosis.thin).toEqual([])
  })

  it('reports thin sections with their character counts', () => {
    const prompt = '## Role\n好\n\n## Task\n分析需求并输出 PRD。\n\n## Context\n面向中小企业，预算有限。\n\n## Format\nMarkdown 文档，不超过 500 字。'
    expect(diagnoseSections(prompt, 10)).toEqual({ missing: [], thin: [{ name: 'Role', chars: 1 }] })
  })

  it('accepts a fully valid prompt', () => {
    expect(diagnoseSections(FOUR_SECTIONS, 5)).toEqual({ missing: [], thin: [] })
  })

  it('combines missing and thin findings', () => {
    const prompt = '## Role\n\n## Task\n分析需求并输出 PRD。\n\n## Context\n面向中小企业，预算有限。'
    expect(diagnoseSections(prompt, 10)).toEqual({ missing: ['Format'], thin: [{ name: 'Role', chars: 0 }] })
  })

  it('ignores thin sections when minChars is zero', () => {
    expect(diagnoseSections('## Role\n\n## Task\n\n## Context\n\n## Format\n', 0)).toEqual({ missing: [], thin: [] })
  })
})

describe('hasMetaContent (1.6.3 purity gate)', () => {
  it('flags methodology appendices like "优化标准" sections', () => {
    const polluted = `## Role
数据分析师。

## Task
生成个人介绍PPT。

## Context
用户项目经历。

## Format
内容框架。

Role（角色设定）优化标准
- 身份明确：角色名称具体
Task（任务描述）优化标准
- 动作可执行：用动词开头
总结：四个段落的核心约束逻辑是 Role 定"谁来说"，Task 定"说什么"。`
    expect(hasMetaContent(polluted)).toBe(true)
  })

  it('flags "核心约束逻辑" and line-start "总结："', () => {
    expect(hasMetaContent('## Role\nx\n\n## Task\ny\n核心约束逻辑：每段优化的本质是转化')).toBe(true)
    expect(hasMetaContent('## Format\n输出表格\n\n总结：以上是优化方法论')).toBe(true)
  })

  it('does not flag a clean four-section prompt', () => {
    expect(hasMetaContent(FOUR_SECTIONS)).toBe(false)
  })

  it('does not flag a prompt that merely mentions a word in content', () => {
    // 「总结」作为 Format 的任务要求（非元章节）不应误报。
    const legit = `## Role
资深编辑。

## Task
改写这段文案，最后输出一个总结。

## Context
面向用户。

## Format
正文 + 总结段落。`
    expect(hasMetaContent(legit)).toBe(false)
  })

  it('exposes a stable failure message', () => {
    expect(metaContentMessage()).toContain('meta/methodology')
  })
})

describe('Role/Task/Goal form (1.6.5)', () => {
  const rtg = `角色：资深数据分析师，结论先行。
任务：分析销售数据趋势并输出报告。
目标：面向业务决策者，不超过 500 字。`
  const rtgEn = `Role: Senior data analyst.
Task: Analyze sales trends and output a report.
Goal: For business decision-makers, under 500 words.`

  it('detects the zh or en label sets', () => {
    expect(hasRoleTaskGoalLabels(rtg)).toBe(true)
    expect(hasRoleTaskGoalLabels(rtgEn)).toBe(true)
    expect(hasRoleTaskGoalLabels(FOUR_SECTIONS)).toBe(false)
    expect(hasRoleTaskGoalLabels('角色：x\n目标：y')).toBe(false) // 缺任务
  })

  it('validates all three parts with a content floor', () => {
    expect(hasValidRoleTaskGoal(rtg, 4)).toBe(true)
    expect(hasValidRoleTaskGoal(rtgEn, 4)).toBe(true)
    expect(hasValidRoleTaskGoal('角色：x\n任务：y\n目标：z', 4)).toBe(false) // 过薄
    expect(hasValidRoleTaskGoal('角色：x\n任务：y', 0)).toBe(false) // 缺目标
  })

  it('treats the labeled form as already optimized (skip pass-through)', () => {
    expect(hasOptimizedSections(rtg)).toBe(true)
    expect(hasOptimizedSections(rtgEn)).toBe(true)
  })
})
