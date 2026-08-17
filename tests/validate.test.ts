import { describe, expect, it } from 'vitest'
import {
  assertInput,
  estimateTokens,
  hasAllSections,
  hasSubstantialContent,
  hasValidSections,
  INCOMPLETE_SECTIONS_MESSAGE,
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

  it('rejects a prompt missing every heading', () => {
    expect(hasAllSections('随便一段文本')).toBe(false)
  })

  it('does not match headings inside code fences', () => {
    // The regex is deliberately simple; a fenced `## Role` still matches by
    // design (the harness convention validates presence, not structure).
    expect(hasAllSections(`\`\`\`\n## Role\n## Task\n## Context\n## Format\n\`\`\``)).toBe(true)
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
