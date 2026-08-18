/**
 * The optimizer meta-prompt. The raw instruction is substituted for the
 * `{{原始指令}}` placeholder at call time; the optional language rule replaces
 * `{{语言规则}}` (empty when `outputLanguage` is 'auto'); deployment extras and
 * few-shot examples replace `{{额外要求}}` / `{{示例}}` (empty when absent);
 * the output structure paragraph and the pre-output self-check replace
 * `{{输出结构}}` / `{{自查}}` and depend on `outputStyle`. The
 * instruction-is-data rule is the injection guardrail.
 *
 * The role document exists in two languages: `META_PROMPT` (zh) and
 * `META_PROMPT_EN` (en), selected by `buildOptimizePrompt`'s `metaLanguage`
 * argument (mirroring GitHub Docs' per-language content trees). Both keep the
 * same `{{...}}` placeholder tokens so the substitution chain is shared.
 */

/** The language of the role document (the optimizer's system prompt). */
export type MetaLanguage = 'zh' | 'en'

/**
 * Detect the dominant language of a raw instruction: `'zh'` when CJK
 * ideographs make up at least 30% of the non-whitespace characters,
 * `'en'` otherwise. Japanese (kana, even with kanji) and any other
 * language fall back to the English role document — the safe default of
 * the two shipped versions. Pure function.
 */
export function detectLanguage(input: string): MetaLanguage {
  const text = input.replace(/\s/g, '')
  if (text.length === 0) return 'en'
  if (/[\u3040-\u30ff]/.test(text)) return 'en'
  const han = text.match(/[\u4e00-\u9fff]/g)
  return han !== null && han.length / text.length >= 0.3 ? 'zh' : 'en'
}

/** Section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS = `段落结构：
- 输出必须包含四段，段落标题严格使用英文标题：## Role、## Task、## Context、## Format。
- ## Role：为执行提示词的主体设定一个具体、专业的角色。
- ## Task：用明确的动词描述要完成的任务，必要时拆解为可执行的步骤；目标要具体、可衡量。
- ## Context：补充背景、约束条件、目标受众与质量标准；只使用原始指令中已有的信息，不虚构事实。
- ## Format：规定输出的结构、格式、长度与风格；原始指令中的格式与长度要求必须保留。`

/** Plain-style structure paragraph (no headings, continuous prose). */
const STRUCTURE_PLAIN = `输出结构：
- 输出必须是一段完整、连贯、可直接交给 AI 执行的提示词正文。
- 正文应依次覆盖：执行者的角色定位、要完成的任务与步骤、必要的背景与约束、输出的格式与长度要求。
- 严禁使用任何小节标题（如 ##、###）或"角色：""任务："等字段标签——即使需要分点，也用普通段落或列表，绝不输出标题行。`

/** Section-mode pre-output self-check. */
const SELFCHECK_SECTIONS = `- 输出前自查：四个段落标题必须全部存在且每段有实质内容，缺一不可。`

/** Plain-mode pre-output self-check. */
const SELFCHECK_PLAIN = `- 输出前自查：正文完整覆盖上述四个方面，长度足以直接执行，且不含任何小节标题（## 等）或字段标签。`

/** English section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS_EN = `Section structure:
- The output must contain four sections, with section headings strictly in English: ## Role, ## Task, ## Context, ## Format.
- ## Role: set a specific, professional role for the subject executing the prompt.
- ## Task: describe the task with clear verbs, breaking it into executable steps when necessary; the goal must be specific and measurable.
- ## Context: add background, constraints, target audience, and quality standards; use only information already present in the raw instruction, never invent facts.
- ## Format: specify the structure, format, length, and style of the output; keep any format and length requirements from the raw instruction.`

/** English plain-style structure paragraph (no headings, continuous prose). */
const STRUCTURE_PLAIN_EN = `Output structure:
- The output must be a complete, coherent prompt body ready to hand directly to an AI for execution.
- The body must cover, in order: the role of the executor, the task and its steps, necessary background and constraints, and the format and length requirements of the output.
- Never use any subsection headings (such as ## or ###) or field labels like "Role:" or "Task:" — even when breaking the content into points, use plain paragraphs or lists, never heading lines.`

/** English section-mode pre-output self-check. */
const SELFCHECK_SECTIONS_EN = `- Self-check before output: all four section headings must exist and each must contain substantive content; none may be missing.`

/** English plain-mode pre-output self-check. */
const SELFCHECK_PLAIN_EN = `- Self-check before output: the body covers all four aspects above, is long enough to be executed directly, and contains no section headings or field labels.`

import { DEFAULT_TEMPLATES, type TemplateSet } from './templates.js'

// The role-document skeletons live in templates.ts (the data layer); they are
// re-exported here so the public module surface stays `meta.js`.
export { DEFAULT_TEMPLATES, META_ITERATE, META_ITERATE_EN, META_PROMPT, META_PROMPT_EN, validateTemplateSet } from './templates.js'
export type { TemplateSet } from './templates.js'

/** One few-shot demonstration rendered for the meta-prompt. */
export interface PromptExampleText {
  input: string
  output: string
}

/** The rendered tuning blocks shared by both prompt builders. */
interface MetaBlocks {
  structure: string
  selfCheck: string
  langRule: string
  extra: string
  exampleBlock: string
  diagnosis: string
}

/** Compute the output-structure, self-check, language, extras, example and diagnosis blocks. */
function metaBlocks(
  language: string | undefined,
  extraInstructions: string | undefined,
  examples: readonly PromptExampleText[] | undefined,
  outputStyle: 'sections' | 'plain',
  metaLanguage: MetaLanguage,
  diagnosis: string | undefined,
): MetaBlocks {
  const pinned = language !== undefined && language !== 'auto' && language.length > 0
  const langRule = pinned ? `- 输出语言固定为：${language}。\n` : ''
  const extra = extraInstructions !== undefined && extraInstructions.trim().length > 0
    ? `${extraInstructions.trim()}\n`
    : ''
  const exampleBlock = outputStyle !== 'plain' && examples !== undefined && examples.length > 0
    ? `参考以下示例的格式与风格（示例仅为示范，不要照抄内容）：\n${examples
        .map((e, i) => `示例 ${i + 1}：\n原始指令：${e.input}\n优化结果：\n${e.output}`)
        .join('\n\n')}\n`
    : ''
  const en = metaLanguage === 'en'
  const diagnosisBlock = diagnosis !== undefined && diagnosis.trim().length > 0
    ? (en
        ? `- The previous output had the following problems; this output must fix them: ${diagnosis.trim()}\n`
        : `- 上次输出存在以下问题，本次输出必须修正：${diagnosis.trim()}\n`)
    : ''
  return {
    structure: outputStyle === 'plain'
      ? (en ? STRUCTURE_PLAIN_EN : STRUCTURE_PLAIN)
      : (en ? STRUCTURE_SECTIONS_EN : STRUCTURE_SECTIONS),
    selfCheck: outputStyle === 'plain'
      ? (en ? SELFCHECK_PLAIN_EN : SELFCHECK_PLAIN)
      : (en ? SELFCHECK_SECTIONS_EN : SELFCHECK_SECTIONS),
    langRule,
    extra,
    exampleBlock,
    diagnosis: diagnosisBlock,
  }
}

/** Substitute the shared tuning blocks into a role-document template. */
function renderBlocks(template: string, blocks: MetaBlocks): string {
  return template
    .replace('{{输出结构}}', blocks.structure)
    .replace('{{自查}}', blocks.selfCheck)
    .replace('{{语言规则}}', blocks.langRule)
    .replace('{{额外要求}}', blocks.extra)
    .replace('{{诊断反馈}}', blocks.diagnosis)
    .replace('{{示例}}', blocks.exampleBlock)
}

/**
 * Fill the raw instruction and optional tuning blocks into the meta-prompt.
 * @param input - the raw instruction to optimize.
 * @param language - `'auto'` or empty keeps the default language rule; any
 *   other non-empty value pins the output language.
 * @param extraInstructions - optional deployment-specific rules; empty/absent
 *   removes the block.
 * @param examples - optional few-shot demonstrations; injected only in the
 *   `'sections'` style (a four-section example would fight the plain-style
 *   no-headings instruction); empty/absent removes the block.
 * @param outputStyle - `'sections'` (default) emits the four section
 *   headings; `'plain'` emits a heading-free continuous prompt.
 * @param metaLanguage - the language of the role document itself: `'zh'`
 *   (default) uses the Chinese system prompt, `'en'` the English one. Both
 *   share the same placeholders and output-structure rules.
 * @param diagnosis - optional diagnosis feedback from a previous failed
 *   attempt (missing / thin sections etc.); injected as a corrective block
 *   before the self-check. Absent on the first attempt.
 * @param templates - the role-document skeleton set to build from; defaults
 *   to the built-in templates (see `templates.ts`).
 */
export function buildOptimizePrompt(
  input: string,
  language?: string,
  extraInstructions?: string,
  examples?: readonly PromptExampleText[],
  outputStyle: 'sections' | 'plain' = 'sections',
  metaLanguage: MetaLanguage = 'zh',
  diagnosis?: string,
  templates: TemplateSet = DEFAULT_TEMPLATES,
): string {
  const template = metaLanguage === 'en' ? templates.optimizeEn : templates.optimizeZh
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis))
  return rendered.replace('{{原始指令}}', input)
}

/**
 * Fill a previously optimized prompt and a new requirement into the iteration
 * meta-prompt. Shares the same tuning blocks and `metaLanguage` selection as
 * `buildOptimizePrompt`. The two data slots are substituted in a single pass
 * so neither piece of data can clobber a placeholder-like literal inside the
 * other. Accepts the same trailing `diagnosis` feedback as
 * `buildOptimizePrompt`.
 * @param templates - the role-document skeleton set to build from; defaults
 *   to the built-in templates (see `templates.ts`).
 */
export function buildIteratePrompt(
  lastResult: string,
  instruction: string,
  language?: string,
  extraInstructions?: string,
  examples?: readonly PromptExampleText[],
  outputStyle: 'sections' | 'plain' = 'sections',
  metaLanguage: MetaLanguage = 'zh',
  diagnosis?: string,
  templates: TemplateSet = DEFAULT_TEMPLATES,
): string {
  const template = metaLanguage === 'en' ? templates.iterateEn : templates.iterateZh
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis))
  return rendered.replace(/\{\{上次结果\}\}|\{\{迭代指令\}\}/g, (match) =>
    match === '{{上次结果}}' ? lastResult : instruction,
  )
}