/**
 * The optimizer meta-prompt. The raw instruction is substituted for the
 * `{{原始指令}}` placeholder at call time; the optional language rule replaces
 * `{{语言规则}}` (empty when `outputLanguage` is 'auto'); deployment extras and
 * few-shot examples replace `{{额外要求}}` / `{{示例}}` (empty when absent);
 * the detected task category replaces `{{任务类型}}` (empty when `'other'`);
 * the suggested output-length cap replaces `{{长度预算}}` (empty when disabled);
 * the situation profile replaces `{{情境画像}}` (empty when no usable signals);
 * the output structure paragraph and the pre-output self-check replace
 * `{{输出结构}}` / `{{自查}}` and depend on `outputStyle`; optional
 * conversation context replaces `{{上下文信息}}` (empty when `contextAware`
 * is off). The instruction-is-data rule is the injection guardrail.
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

/**
 * Coarse task categories the optimizer can react to (content-aware roles and
 * format defaults). A pure heuristic: keyword scoring per category, with a
 * fixed tie-break priority `code > analysis > ops > writing` (writing markers
 * like "写" are the most generic and only win on their own). `'other'` when
 * nothing matches — the role document then stays silent on the category.
 */
export type TaskType = 'code' | 'writing' | 'analysis' | 'ops' | 'other'

/** Keyword lists per task category, matched case-insensitively as substrings. */
const TASK_KEYWORDS: Record<Exclude<TaskType, 'other'>, readonly string[]> = {
  code: ['代码', '编程', '开发', '函数', '接口', '脚本', '程序', '编译', '调试', 'bug', '报错', '测试用例', '前端', '后端', 'api', 'sql', '数据库', '正则', '框架', 'docker', '命令行', 'bash', 'python', 'javascript', 'typescript', '算法', '重构', 'code', 'refactor', 'script', 'function', 'debug', 'compile'],
  analysis: ['分析', '研究', '评估', '对比', '比较', '预测', '趋势', '数据', '统计', '指标', '原因', '影响', '调研', '审查', '复盘', '解读', '方案', '洞察'],
  ops: ['运行', '执行', '操作', '启动', '停止', '安装', '配置', '运维', '监控', '备份', '恢复', '迁移', '排查', '修复', '步骤', '命令'],
  writing: ['写', '撰写', '文案', '文章', '报告', '邮件', '总结', '摘要', '标题', '润色', '翻译', '改写', '回复', '宣传', '营销', '广告', '故事', '小说', '诗', '周报', '日报', '简历', '演讲', '新闻稿', '博客', '公众号', 'write', 'report', 'email', 'article', 'summary', 'translate'],
}

/**
 * Pick the item whose keyword list scores highest against `lower` (each
 * keyword matched as a case-insensitive substring scores 1). The strictly-
 * greater comparison keeps the FIRST item on ties, so iteration order is the
 * tie-break priority. Returns the winner and its score (score 0 → no winner).
 * Shared by `detectTaskType` (category table) and `detectTaskSubtype`
 * (subcategory tables) — adding a keyword category only edits the table.
 */
export function bestScoreByKeywords<T extends { keywords: readonly string[] }>(
  items: readonly T[],
  lower: string,
): { item: T | undefined; score: number } {
  let best: T | undefined
  let bestScore = 0
  for (const item of items) {
    const score = item.keywords.reduce((n, kw) => n + (lower.includes(kw.toLowerCase()) ? 1 : 0), 0)
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return { item: best, score: bestScore }
}

/** Detect the coarse task category of a raw instruction. Pure function. */
export function detectTaskType(input: string): TaskType {
  const lower = input.toLowerCase()
  const kinds = Object.keys(TASK_KEYWORDS) as (keyof typeof TASK_KEYWORDS)[]
  // Iteration order is the tie-break priority; the first category reaching a
  // new max wins ties (strictly-greater comparison keeps the earlier kind).
  const { item } = bestScoreByKeywords(kinds.map((kind) => ({ kind, keywords: TASK_KEYWORDS[kind] })), lower)
  return item !== undefined ? item.kind : 'other'
}

/** Per-category role/format hints injected as the `{{任务类型}}` block (zh). */
const TASKTYPE_ZH: Record<Exclude<TaskType, 'other'>, string> = {
  code: '任务类型提示：该指令检测为编程/开发类任务——角色定位应偏向相关领域的资深技术专家（如资深工程师、架构师），并在输出中明确输出语言、代码可运行性与必要的注释要求。\n角色写法建议：偏向能力导向——用"精通/熟悉/擅长…"描述技术栈与专长，比单纯"你是工程师"更可执行；能力陈述保持简短（一句为限）、与任务直接相关，不展开完整技术栈清单。',
  writing: '任务类型提示：该指令检测为写作/文案类任务——角色定位应偏向对应领域的资深撰稿人或编辑，并在输出中明确文体、篇幅、语气与目标读者。\n角色写法建议：偏向身份＋文体——给出身份（如"资深撰稿人"），并明确文体、篇幅与语气。',
  analysis: '任务类型提示：该指令检测为分析/研究类任务——角色定位应偏向分析师或研究员，并在输出中明确结论先行、给出依据与数据来源、说明分析维度。\n角色写法建议：偏向身份＋方法——给出身份（如"分析师/研究员"），并说明分析方法（如"结论先行、数据支撑"）。',
  ops: '任务类型提示：该指令检测为执行/操作类任务——角色定位应偏向执行者或运维角色，并在输出中明确步骤顺序、前置条件与完成检查。\n角色写法建议：偏向行为约束＋步骤——说明执行边界与步骤顺序（如"先确认环境、按清单操作、完成后自检"）。',
}

/** Per-category role/format hints injected as the `{{任务类型}}` block (en). */
const TASKTYPE_EN: Record<Exclude<TaskType, 'other'>, string> = {
  code: 'Task-type hint: this instruction is detected as a coding/development task — lean the role toward a senior technical expert (e.g. senior engineer, architect), and make the output explicit about the language, runnability of the code, and any required comments.\nRole-writing tip: lean capability-oriented — describe the stack and expertise with "proficient in / skilled at / familiar with…" rather than a bare "you are an engineer"; keep the capability statement brief (one sentence), directly relevant to the task, and free of a full technology-stack list.',
  writing: 'Task-type hint: this instruction is detected as a writing task — lean the role toward a senior writer or editor for the domain, and make the output explicit about the genre, length, tone, and target reader.\nRole-writing tip: lean identity + genre — name the persona (e.g. "senior copywriter") and be explicit about genre, length and tone.',
  analysis: 'Task-type hint: this instruction is detected as an analysis/research task — lean the role toward an analyst or researcher, and make the output explicit about leading with conclusions, citing evidence and data sources, and listing the analysis dimensions.\nRole-writing tip: lean identity + method — name the persona (e.g. "analyst / researcher") and the analysis approach (e.g. "lead with conclusions, back them with data").',
  ops: 'Task-type hint: this instruction is detected as an execution/operations task — lean the role toward an executor or ops persona, and make the output explicit about step order, prerequisites, and completion checks.\nRole-writing tip: lean behavior + steps — state execution boundaries and step order (e.g. "verify the environment first, follow the checklist, self-check when done").',
}

/** Section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS = `段落结构：
- 输出必须包含四段，段落标题严格使用英文标题：## Role、## Task、## Context、## Format。
- 全局：输出必须精炼——删除与任务要求重复的表述、空话与无意义假设；每条信息以一句为限。
- ## Role：为执行提示词的主体设定具体角色，采用「身份＋能力＋行为」三要素写法——身份（如"资深工程师"）不必以"你是"开头，能力（如"精通 Python"）与行为约束（如"先给结论、拒绝猜测"）同样合格且往往更可执行；角色必须与任务强相关——原始指令已明确执行主体时沿用，否则按任务类型与领域推断（代码任务对应资深工程师、文案对应资深撰稿人），并体现所需专业度；避免"AI 助手"这类空泛角色；能力陈述保持简短、与任务直接相关，不重复 Task 已覆盖的要求。
- ## Task：用明确的动词描述要完成的任务，必要时拆解为可执行的步骤；目标要具体、可衡量；说明完成标准（做到什么程度算完成）。
- ## Context：补充背景、约束条件、目标受众与质量标准；信息可来自原始指令或对话上下文，不得虚构新事实，原始指令已含的信息不必重复；仅当信息确实缺失时声明假设，无缺失时不得编造假设。
- ## Format：规定输出的结构、格式、长度与风格；原始指令中的格式与长度要求必须保留；结构、格式、长度与风格四项须齐全，原始指令未明确的给合理默认；输出分类/结构应与 Task 要求的维度一一对应、顺序一致。`

/** Plain-style structure paragraph (no headings, continuous prose). */
const STRUCTURE_PLAIN = `输出结构：
- 输出必须是一段完整、连贯、可直接交给 AI 执行的提示词正文。
- 正文应依次覆盖：执行者的角色定位（与任务强相关、避免空泛角色；建议"身份＋能力＋行为"三要素写法，不必以"你是"开头）、要完成的任务与步骤（含完成标准）、必要的背景与约束（不虚构事实，信息不足时声明假设）、输出的格式与长度要求（未明确处给合理默认）。
- 正文必须精炼——删除与任务要求重复的表述、空话与无意义假设；每条信息以一句为限；输出分类/结构与任务要求的维度一一对应、顺序一致。
- 严禁使用任何小节标题（如 ##、###）或"角色：""任务："等字段标签——即使需要分点，也用普通段落或列表，绝不输出标题行。`

/** Section-mode pre-output self-check. */
const SELFCHECK_SECTIONS = `- 输出前自查：四个段落标题必须全部存在且每段有实质内容；角色与任务强相关、不空泛，且含能力或行为描述（仅一句空身份不算合格）；Context 无虚构事实；Format 覆盖结构、格式、长度与风格四项；整体无重复表述、无空话、无多余假设，长度在满足要求前提下尽量短。缺一不可。`

/** Plain-mode pre-output self-check. */
const SELFCHECK_PLAIN = `- 输出前自查：正文完整覆盖上述四个方面（含完成标准、假设声明与格式默认值），长度足以直接执行，且不含任何小节标题（## 等）或字段标签；角色部分需含能力或行为描述，仅一句空泛身份不算合格；整体无重复表述、无空话、无多余假设，长度在满足要求前提下尽量短。`

/** English section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS_EN = `Section structure:
- The output must contain four sections, with section headings strictly in English: ## Role, ## Task, ## Context, ## Format.
- Global: the output must be concise — drop statements that repeat the task requirements, filler, and meaningless assumptions; keep every piece of information to one sentence.
- ## Role: set a specific role for the subject executing the prompt using the three-part formula "identity + capability + behavior"; the identity (e.g. "senior engineer") need not start with "you are", and a capability clause ("proficient in Python") or a behavior clause ("lead with conclusions, never guess") is equally valid and often more actionable; the role must be strongly tied to the task — reuse an explicit executor from the raw instruction when present, otherwise infer it from the task type and domain (e.g. senior engineer for coding, senior copywriter for writing), and reflect the required expertise; avoid generic roles like "AI assistant"; keep capability statements brief, directly relevant to the task, and free of requirements already covered in ## Task.
- ## Task: describe the task with clear verbs, breaking it into executable steps when necessary; the goal must be specific and measurable; state the completion criteria (what counts as done).
- ## Context: add background, constraints, target audience, and quality standards; facts may come from the raw instruction or the conversation context — never invent new ones and do not repeat what the raw instruction already states; state assumptions only when information is genuinely missing — never invent an assumption when nothing is missing.
- ## Format: specify the structure, format, length, and style of the output; keep any format and length requirements from the raw instruction; cover all four aspects, giving reasonable defaults for any the raw instruction does not specify; the output categories/structure must mirror the dimensions required in ## Task, in the same order.`

/** English plain-style structure paragraph (no headings, continuous prose). */
const STRUCTURE_PLAIN_EN = `Output structure:
- The output must be a complete, coherent prompt body ready to hand directly to an AI for execution.
- The body must cover, in order: the role of the executor (strongly tied to the task, not generic; prefer the "identity + capability + behavior" formula — starting with "you are" is optional), the task and its steps (including completion criteria), necessary background and constraints (no invented facts; state assumptions when information is missing), and the format and length requirements of the output (with reasonable defaults where unspecified).
- The body must be concise — drop statements that repeat the task requirements, filler, and meaningless assumptions; keep every piece of information to one sentence; the output categories/structure must mirror the dimensions required by the task, in the same order.
- Never use any subsection headings (such as ## or ###) or field labels like "Role:" or "Task:" — even when breaking the content into points, use plain paragraphs or lists, never heading lines.`

/** English section-mode pre-output self-check. */
const SELFCHECK_SECTIONS_EN = `- Self-check before output: all four section headings must exist and each must contain substantive content; the role must be strongly tied to the task, not generic, and include a capability or behavior clause (a bare identity alone does not qualify); the context must contain no invented facts; the format must cover structure, format, length, and style; the output must contain no repeated statements, filler, or meaningless assumptions, and be as short as possible while meeting the requirements. None may be missing.`

/** English plain-mode pre-output self-check. */
const SELFCHECK_PLAIN_EN = `- Self-check before output: the body covers all four aspects above (completion criteria, assumptions, and format defaults included), is long enough to be executed directly, and contains no section headings or field labels; the role part must include a capability or behavior clause — a bare generic identity does not qualify; the body must contain no repeated statements, filler, or meaningless assumptions, and be as short as possible while meeting the requirements.`

/**
 * Placeholder-to-block-key mapping for efficient template rendering.
 * Single-replace strategy prevents double-substitution issues.
 */
const PLACEHOLDER_MAP: Readonly<Record<string, keyof MetaBlocks>> = {
  '{{输出结构}}': 'structure',
  '{{自查}}': 'selfCheck',
  '{{语言规则}}': 'langRule',
  '{{额外要求}}': 'extra',
  '{{任务类型}}': 'taskType',
  '{{长度预算}}': 'length',
  '{{情境画像}}': 'situation',
  '{{诊断反馈}}': 'diagnosis',
  '{{示例}}': 'exampleBlock',
  '{{上下文信息}}': 'context',
} as const

import { DEFAULT_TEMPLATES, type TemplateSet } from './templates.js'
import type { PromptExample } from './config.js'
import { buildContextBlock } from './context.js'
import { buildSituationProfile, renderSituationBlock, subtypeLabel, type GoalDrift, type SituationProfile, type SituationProfileLevel, type TaskSubtype } from './situation.js'

// The role-document skeletons live in templates.ts (the data layer); they are
// re-exported here so the public module surface stays `meta.js`.
export { DEFAULT_TEMPLATES, META_ITERATE, META_ITERATE_EN, META_PROMPT, META_PROMPT_EN, validateTemplateSet } from './templates.js'
export type { TemplateSet } from './templates.js'

/** The rendered tuning blocks shared by both prompt builders. */
interface MetaBlocks {
  structure: string
  selfCheck: string
  langRule: string
  extra: string
  exampleBlock: string
  diagnosis: string
  context: string
  taskType: string
  length: string
  situation: string
}

/** Compute the output-structure, self-check, language, extras, example, diagnosis and context blocks. */
function metaBlocks(
  language: string | undefined,
  extraInstructions: string | undefined,
  examples: readonly PromptExample[] | undefined,
  outputStyle: 'sections' | 'plain',
  metaLanguage: MetaLanguage,
  diagnosis: string | undefined,
  context: string | undefined,
  taskType: TaskType | undefined,
  maxOutputTokens: number | undefined,
  profile: SituationProfile | undefined,
  subtype: TaskSubtype | undefined,
  drift: GoalDrift | undefined,
  level: SituationProfileLevel | undefined,
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
  const taskTypeBlock = taskType !== undefined && taskType !== 'other'
    ? `${en ? TASKTYPE_EN[taskType] : TASKTYPE_ZH[taskType]}\n`
    : ''
  // `detectTaskSubtype` returns `undefined` for `'other'` and for unmatched
  // inputs, so a defined subtype already implies a non-`'other'` task type —
  // the extra `taskType` checks are redundant.
  const subtypeBlock = subtype !== undefined
    ? (en
        ? `- Subtype hint: this instruction falls into the 【${subtypeLabel(subtype, true)}】 category.\n`
        : `- 子类提示：该指令属于【${subtypeLabel(subtype, false)}】类任务。\n`)
    : ''
  const lengthBlock = maxOutputTokens !== undefined && maxOutputTokens > 0
    ? (en
        ? `- Suggested output length: no more than ${maxOutputTokens} tokens. Soft guideline — be as concise as the task allows, never pad to fill it.\n`
        : `- 建议输出长度不超过 ${maxOutputTokens} token。此为软约束：在覆盖完整的前提下尽量精简，不要刻意凑满。\n`)
    : ''
  const situationBlock = profile !== undefined ? renderSituationBlock(profile, en, drift, level) : ''
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
    context: buildContextBlock(context ?? '', metaLanguage, outputStyle),
    taskType: `${taskTypeBlock}${subtypeBlock}`,
    length: lengthBlock,
    situation: situationBlock,
  }
}

/** Substitute the shared tuning blocks into a role-document template. */
function renderBlocks(template: string, blocks: MetaBlocks): string {
  let result = template

  // Single-pass replacement using the placeholder map
  for (const [placeholder, blockKey] of Object.entries(PLACEHOLDER_MAP)) {
    const replacement = blocks[blockKey] as string
    result = result.replace(placeholder, replacement)
  }

  // Validate: check for any remaining unknown placeholders
  const remainingPlaceholders = result.match(/{{[\w\u4e00-\u9fff]+}}/g)
  if (remainingPlaceholders !== null && remainingPlaceholders.length > 0) {
    const knownPlaceholders = Object.keys(PLACEHOLDER_MAP)
    const unknownPlaceholders = remainingPlaceholders.filter(p => !knownPlaceholders.includes(p))
    if (unknownPlaceholders.length > 0) {
      // Log warning but don't break (allow dynamic placeholders)
      console.warn(`Unknown placeholders found: ${unknownPlaceholders.join(', ')}`)
    }
  }

  return result
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
 * @param context - optional conversation context (background reference only);
 *   injected as the `{{上下文信息}}` block when non-empty.
 * @param taskType - detected task category; `undefined` auto-detects from
 *   `input` and injects the `{{任务类型}}` hint when not `'other'`.
 * @param maxOutputTokens - optional suggested output-length cap (soft
 *   guideline only); `undefined`/`0` injects no `{{长度预算}}` block.
 * @param profile - optional situation profile (role/task/goal); `undefined`
 *   auto-builds it from `input` (and `context`, for role cues) and injects
 *   the `{{情境画像}}` block when it carries usable signals.
 * @param level - optional injection budget for the situation block
 *   (`'off'`/`'minimal'`/`'full'`); `undefined` behaves as `'full'`.
 */
export function buildOptimizePrompt(
  input: string,
  language?: string,
  extraInstructions?: string,
  examples?: readonly PromptExample[],
  outputStyle: 'sections' | 'plain' = 'sections',
  metaLanguage: MetaLanguage = 'zh',
  diagnosis?: string,
  templates: TemplateSet = DEFAULT_TEMPLATES,
  context?: string,
  taskType?: TaskType,
  maxOutputTokens?: number,
  profile?: SituationProfile,
  level?: SituationProfileLevel,
): string {
  const template = metaLanguage === 'en' ? templates.optimizeEn : templates.optimizeZh
  const resolvedProfile = profile ?? buildSituationProfile(input, context)
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, context, taskType ?? resolvedProfile.task.type, maxOutputTokens, resolvedProfile, resolvedProfile.task.subtype, undefined, level))
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
 * @param context - optional conversation context (background reference only);
 *   injected as the `{{上下文信息}}` block when non-empty.
 * @param taskType - detected task category; `undefined` auto-detects from
 *   the iteration instruction and injects the `{{任务类型}}` hint when not
 *   `'other'`.
 * @param maxOutputTokens - optional suggested output-length cap (soft
 *   guideline only); `undefined`/`0` injects no `{{长度预算}}` block.
 * @param profile - optional situation profile (role/task/goal); `undefined`
 *   auto-builds it from the iteration instruction (and `context`, for role
 *   cues) and injects the `{{情境画像}}` block when it carries usable signals.
 * @param drift - optional goal drift vs the previous round; appends a change
 *   line to the situation block for iteration prompts.
 * @param level - optional injection budget for the situation block
 *   (`'off'`/`'minimal'`/`'full'`); `undefined` behaves as `'full'`.
 */
export function buildIteratePrompt(
  lastResult: string,
  instruction: string,
  language?: string,
  extraInstructions?: string,
  examples?: readonly PromptExample[],
  outputStyle: 'sections' | 'plain' = 'sections',
  metaLanguage: MetaLanguage = 'zh',
  diagnosis?: string,
  templates: TemplateSet = DEFAULT_TEMPLATES,
  context?: string,
  taskType?: TaskType,
  maxOutputTokens?: number,
  profile?: SituationProfile,
  drift?: GoalDrift,
  level?: SituationProfileLevel,
): string {
  const template = metaLanguage === 'en' ? templates.iterateEn : templates.iterateZh
  const resolvedProfile = profile ?? buildSituationProfile(instruction, context)
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, context, taskType ?? resolvedProfile.task.type, maxOutputTokens, resolvedProfile, resolvedProfile.task.subtype, drift, level))
  return rendered.replace(/\{\{上次结果\}\}|\{\{迭代指令\}\}/g, (match) =>
    match === '{{上次结果}}' ? lastResult : instruction,
  )
}