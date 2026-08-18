import { describe, expect, it } from 'vitest'
import { buildDiagnosis, refineInstruction } from '../src/diagnose.js'
import { OptimizeErrorCode } from '../src/errors.js'

describe('buildDiagnosis', () => {
  const FOUR_SECTIONS =
    '## Role\n你是一名资深的产品经理分析师\n\n## Task\n撰写一份面向团队的周报,列出进展与风险\n\n## Context\n团队五人,正在推进新版本\n\n## Format\n输出三百字以内的正文'
  const base = { minSectionChars: 10, prompt: FOUR_SECTIONS }

  it('returns plain-style thin-output feedback in Chinese', () => {
    expect(buildDiagnosis({ ...base, outputStyle: 'plain', language: 'zh', failureCode: OptimizeErrorCode.THIN_OUTPUT }))
      .toBe('输出过短（少于 10 有效字符）。请输出完整、可直接执行的提示词正文。')
  })

  it('returns plain-style thin-output feedback in English', () => {
    expect(buildDiagnosis({ ...base, outputStyle: 'plain', language: 'en', failureCode: OptimizeErrorCode.THIN_OUTPUT }))
      .toBe('The output was too short (fewer than 10 meaningful characters). Write a complete, directly executable prompt body.')
  })

  it('returns undefined for a non-thin failure in plain style', () => {
    expect(buildDiagnosis({ ...base, outputStyle: 'plain', language: 'zh', failureCode: OptimizeErrorCode.MISSING_SECTIONS }))
      .toBeUndefined()
  })

  it('names the missing sections in Chinese', () => {
    const prompt = '## Role\n你是一名资深的产品经理分析师\n\n## Task\n撰写一份面向团队的周报,列出进展与风险'
    const diagnosis = buildDiagnosis({ ...base, prompt, outputStyle: 'sections', language: 'zh', failureCode: OptimizeErrorCode.MISSING_SECTIONS })
    expect(diagnosis).toContain('缺少以下段落：## Context、## Format')
  })

  it('names the missing sections in English', () => {
    const prompt = '## Role\n你是一名资深的产品经理分析师'
    const diagnosis = buildDiagnosis({ ...base, prompt, outputStyle: 'sections', language: 'en', failureCode: OptimizeErrorCode.MISSING_SECTIONS })
    expect(diagnosis).toBe('Missing sections: ## Task、## Context、## Format. Output all four headings (## Role, ## Task, ## Context, ## Format) with substantive content.')
  })

  it('reports thin sections with their character counts', () => {
    const prompt = '## Role\nx\n\n## Task\n撰写一份面向团队的周报,列出进展与风险\n\n## Context\n团队五人,正在推进新版本\n\n## Format\n输出三百字以内的正文'
    const diagnosis = buildDiagnosis({ ...base, prompt, outputStyle: 'sections', language: 'zh', failureCode: OptimizeErrorCode.THIN_SECTIONS })
    expect(diagnosis).toContain('以下段落内容过少（少于 10 有效字符）：## Role（实际 1 字）')
  })

  it('reports thin sections in English with char counts', () => {
    const prompt = '## Role\nx\n\n## Task\n撰写一份面向团队的周报,列出进展与风险\n\n## Context\n团队五人,正在推进新版本\n\n## Format\n输出三百字以内的正文'
    const diagnosis = buildDiagnosis({ ...base, prompt, outputStyle: 'sections', language: 'en', failureCode: OptimizeErrorCode.THIN_SECTIONS })
    expect(diagnosis).toContain('Thin section: ## Role (1 chars) (fewer than 10 meaningful characters). Add substantive content.')
  })

  it('combines missing and thin feedback into one message', () => {
    const prompt = '## Role\n你是一名资深的产品经理分析师\n\n## Task\nx'
    const diagnosis = buildDiagnosis({ ...base, prompt, outputStyle: 'sections', language: 'zh', failureCode: OptimizeErrorCode.THIN_SECTIONS })
    expect(diagnosis).toContain('缺少以下段落：## Context、## Format')
    expect(diagnosis).toContain('## Task（实际 1 字）')
  })

  it('returns undefined for unrelated failure codes in sections style', () => {
    expect(buildDiagnosis({ ...base, outputStyle: 'sections', language: 'zh', failureCode: OptimizeErrorCode.THIN_OUTPUT }))
      .toBeUndefined()
  })

  it('returns undefined when there is nothing actionable', () => {
    expect(buildDiagnosis({ ...base, outputStyle: 'sections', language: 'zh', failureCode: OptimizeErrorCode.MISSING_SECTIONS }))
      .toBeUndefined()
  })
})

describe('refineInstruction', () => {
  it('returns the Chinese terse-only instruction', () => {
    expect(refineInstruction('zh')).toBe('保持结构与内容不变，进一步精简冗余表述，确保可直接执行。若已足够精简，原样返回。')
  })

  it('returns the English terse-only instruction', () => {
    expect(refineInstruction('en')).toBe('Keep the structure and content unchanged, but tighten redundant wording further. If it is already concise enough, return it as-is.')
  })
})
