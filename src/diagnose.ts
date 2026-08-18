import { OptimizeErrorCode } from './errors.js'
import type { OptimizeErrorCode as OptimizeErrorCodeType } from './errors.js'
import { diagnoseSections } from './validate.js'
import type { MetaLanguage } from './meta.js'

/**
 * Build corrective feedback for the next retry from the last failed output:
 * which sections were missing / too thin (sections style) or that the body
 * was too short (plain style). Returns `undefined` when there is no
 * actionable structure diagnosis — the retry then keeps the plain
 * temperature bump instead. The text follows the role-document language.
 * Pure function; no harness dependency (unit-testable without `llm`).
 */
export function buildDiagnosis(opts: {
  outputStyle: 'sections' | 'plain'
  minSectionChars: number
  language: MetaLanguage
  prompt: string
  failureCode: OptimizeErrorCodeType
}): string | undefined {
  const { outputStyle, minSectionChars, language, prompt, failureCode } = opts
  const en = language === 'en'
  if (outputStyle === 'plain') {
    if (failureCode === OptimizeErrorCode.HEADINGS_IN_PLAIN) {
      return en
        ? 'The output must not contain any section headings (## Role, ## Task, ## Context, ## Format) or field labels. Rewrite it as one continuous prompt body without headings.'
        : '输出不得包含任何小节标题（## Role、## Task、## Context、## Format）或字段标签。请改写为一段连贯、无标题的提示词正文。'
    }
    if (failureCode !== OptimizeErrorCode.THIN_OUTPUT) return undefined
    return en
      ? `The output was too short (fewer than ${minSectionChars} meaningful characters). Write a complete, directly executable prompt body.`
      : `输出过短（少于 ${minSectionChars} 有效字符）。请输出完整、可直接执行的提示词正文。`
  }
  if (
    failureCode !== OptimizeErrorCode.MISSING_SECTIONS &&
    failureCode !== OptimizeErrorCode.THIN_SECTIONS
  ) {
    return undefined
  }
  const { missing, thin } = diagnoseSections(prompt, minSectionChars)
  const parts: string[] = []
  if (missing.length > 0) {
    const names = missing.map((s) => `## ${s}`).join('、')
    parts.push(
      en
        ? `Missing section${missing.length > 1 ? 's' : ''}: ${names}. Output all four headings (## Role, ## Task, ## Context, ## Format) with substantive content.`
        : `缺少以下段落：${names}。请确保输出包含全部四个段落标题（## Role、## Task、## Context、## Format），且每段有实质内容。`,
    )
  }
  if (thin.length > 0) {
    const names = thin
      .map((t) => `## ${t.name}${en ? ` (${t.chars} chars)` : `（实际 ${t.chars} 字）`}`)
      .join(en ? ', ' : '、')
    parts.push(
      en
        ? `Thin section${thin.length > 1 ? 's' : ''}: ${names} (fewer than ${minSectionChars} meaningful characters). Add substantive content.`
        : `以下段落内容过少（少于 ${minSectionChars} 有效字符）：${names}。请补充实质内容。`,
    )
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * The terse-only instruction for a `selfRefine` round (private, not a
 * public template). Follows the role-document language. Pure function.
 */
export function refineInstruction(language: MetaLanguage): string {
  return language === 'en'
    ? 'Keep the structure and content unchanged, but tighten redundant wording further. If it is already concise enough, return it as-is.'
    : '保持结构与内容不变，进一步精简冗余表述，确保可直接执行。若已足够精简，原样返回。'
}
