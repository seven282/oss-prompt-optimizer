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
  ops: ['运行', '执行', '操作', '启动', '停止', '安装', '配置', '运维', '监控', '备份', '恢复', '迁移', '排查', '修复', '步骤', '命令', '部署', '发布', '上线', 'deploy', 'release'],
  writing: ['写', '撰写', '文案', '文章', '报告', '邮件', '总结', '摘要', '标题', '润色', '翻译', '改写', '回复', '宣传', '营销', '广告', '故事', '小说', '诗', '周报', '日报', '简历', '演讲', '新闻稿', '博客', '公众号', '生成', 'ppt', 'presentation', '幻灯片', '演示', 'write', 'report', 'email', 'article', 'summary', 'translate'],
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
  const { item, score } = bestScoreByKeywords(kinds.map((kind) => ({ kind, keywords: TASK_KEYWORDS[kind] })), lower)
  if (item === undefined) return 'other'
  // Unified tie-break: writing verbs (写/撰写/起草/编写/拟…) are strong
  // writing-category signals — when the winning category ties with writing,
  // writing wins. This covers both ops-tie and analysis-tie cases with a
  // single function (unified from 1.5.5 + 1.6.7).
  return resolveWritingTieBreak(item.kind, score, lower)
}

/**
 * Explicit writing verbs — strong writing-category signal (1.5.5 tie-break).
 * When a writing verb appears in the instruction and the winning category
 * ties with writing, writing wins. This prevents "帮我写一份新产品发布公告"
 * from being classified as ops-deploy (发布) instead of writing-copy.
 */
const WRITING_VERB_RE = /写|撰写|起草|编写|拟写|草拟|润色|翻译/i

/**
 * Resolve category tie-breaks in favor of writing when a writing verb is present.
 *
 * Logic (unified from 1.5.5 + 1.6.7):
 * - Compute writing's score independently.
 * - If the winning category ties with writing AND a writing verb appears,
 *   return 'writing' (writing verbs are strong intent signals).
 * - Otherwise return the original winner.
 *
 * Important: code category always wins ties (iteration order priority),
 * regardless of writing verbs. This preserves "写一个部署脚本" → code.
 *
 * This prevents misclassification like:
 *   "帮我写一份新产品发布公告" → ops (发布) instead of writing
 *   "写…文案…进行能力分析"    → analysis (分析) instead of writing
 */
function resolveWritingTieBreak(
  winner: TaskType,
  winnerScore: number,
  lower: string,
): TaskType {
  // Code always wins ties (iteration order priority), even with writing verbs.
  // "写一个部署脚本" → code, not writing.
  if (winner === 'other' || winner === 'writing' || winner === 'code') return winner
  // Only apply tie-break when a writing verb is present.
  if (!WRITING_VERB_RE.test(lower)) return winner
  // Compute writing's score independently for comparison.
  const writingScore = TASK_KEYWORDS.writing.reduce(
    (n, kw) => n + (lower.includes(kw.toLowerCase()) ? 1 : 0),
    0,
  )
  // Tie-break: writing wins when scores are equal AND both > 0.
  if (winnerScore === writingScore && winnerScore > 0) return 'writing'
  return winner
}

/** Per-category role/format hints injected as the `{{任务类型}}` block (zh).
 *  B1（1.6.8）：三行压一行——「角色写法建议」与结构块的角色公式、自查块的
 *  角色检查语义重复，删除；保留类型声明与一句区块侧重。注入的规定性语句
 *  越少，模型逐句填空的模板腔越轻。 */
const TASKTYPE_ZH: Record<Exclude<TaskType, 'other'>, string> = {
  code: '任务类型提示：这是编程/开发类任务。区块侧重：Task 与 Format 是重点（可运行性、交付物），Role 一句带过。',
  writing: '任务类型提示：这是写作/文案类任务。区块侧重：用心写 Role 与 Context（身份、受众、语气），Format 按常规保留。',
  analysis: '任务类型提示：这是分析/研究类任务，结论先行、给出依据与数据来源；区块侧重：Task 与 Context 是重点，Format 记得结论先行。',
  ops: '任务类型提示：这是执行/操作类任务。区块侧重：Task 与 Format 是重点（步骤、命令、回滚），Role 保持简洁。',
}

/** Per-category role/format hints injected as the `{{任务类型}}` block (en).
 *  Mirrors the zh compression (see TASKTYPE_ZH). */
const TASKTYPE_EN: Record<Exclude<TaskType, 'other'>, string> = {
  code: 'Task-type hint: this is a coding/development task. Section emphasis: Task and Format matter most (runnability, deliverables), keep Role brief.',
  writing: 'Task-type hint: this is a writing task. Section emphasis: spend the care on Role and Context (persona, audience, tone), keep Format usual.',
  analysis: 'Task-type hint: this is an analysis/research task; lead with conclusions backed by evidence and data sources. Section emphasis: Task and Context matter most, let Format lead with the conclusion.',
  ops: 'Task-type hint: this is an execution/operations task. Section emphasis: Task and Format matter most (steps, commands, rollback), keep Role concise.',
}

/**
 * Role library (1.4.9): one ready-to-use "identity + capability + behavior"
 * reference per task category. Injected alongside the `{{任务类型}}` hints so
 * the model has a concrete role fallback when the situation profile carries
 * no explicit role (low-confidence cases) — never injected into the profile.
 */
export const ROLE_LIBRARY: Record<Exclude<TaskType, 'other'>, { zh: string; en: string }> = {
  code: {
    zh: '角色参考：资深工程师，精通 Python/TypeScript，先保证可运行再优化、代码附必要注释。',
    en: 'Role reference: senior engineer, proficient in Python/TypeScript; make it run first, then optimize; annotate where needed.',
  },
  writing: {
    zh: '角色参考：资深撰稿人，擅长公文/营销/技术写作，按文体控制语气与篇幅。',
    en: 'Role reference: senior writer, skilled at business/marketing/technical writing; adapt tone and length to the genre.',
  },
  analysis: {
    zh: '角色参考：数据分析师，擅长趋势解读与因果分析，结论先行、数据支撑。',
    en: 'Role reference: data analyst, skilled at trend interpretation and causal analysis; lead with conclusions, back them with data.',
  },
  ops: {
    zh: '角色参考：资深运维，熟悉 Linux 与部署流程，按步骤执行、先备份后变更。',
    en: 'Role reference: senior ops engineer, familiar with Linux and deployment; follow the steps, back up before changing.',
  },
}

/**
 * Scene-template library (1.5.1): one compact Role/Task/Format skeleton per
 * subcategory. Injected into the `{{任务类型}}` block when the subtype is
 * detected — the model fills in the specifics instead of inventing a shape.
 * Also drives the `/template <scene>` quick command (no model call).
 */
export const SUB_TOPIC_TEMPLATES: Record<TaskSubtype, { zh: string; en: string }> = {
  'code-bugfix': {
    zh: '场景骨架：Role 资深工程师；Task 定位根因→最小修复→回归验证；Format 根因分析 + 改动点 + 测试结果。',
    en: 'Scene skeleton: Role senior engineer; Task root-cause → minimal fix → regression check; Format root cause + changes + test results.',
  },
  'code-feature': {
    zh: '场景骨架：Role 资深工程师；Task 明确需求→方案→实现→测试；Format 功能说明 + 关键实现 + 使用示例。',
    en: 'Scene skeleton: Role senior engineer; Task requirements → design → implementation → tests; Format feature notes + key code + usage example.',
  },
  'code-refactor': {
    zh: '场景骨架：Role 资深工程师；Task 保持行为等价→改进结构/可读性；Format 前后对比 + 行为不变说明。',
    en: 'Scene skeleton: Role senior engineer; Task keep behavior identical while improving structure; Format before/after + behavior-preserved note.',
  },
  'code-review': {
    zh: '场景骨架：Role 资深工程师；Task 按可读性/安全/性能/测试覆盖审查；Format 逐条问题 + 严重度 + 建议。',
    en: 'Scene skeleton: Role senior engineer; Task review readability/security/perf/test coverage; Format itemized issues + severity + suggestions.',
  },
  'code-script': {
    zh: '场景骨架：Role 工程师；Task 明确输入输出→处理异常；Format 可运行代码 + 用法/依赖说明。',
    en: 'Scene skeleton: Role engineer; Task define I/O and handle errors; Format runnable code + usage/deps.',
  },
  'writing-report': {
    zh: '场景骨架：Role 资深撰稿人；Task 结论先行→要点支撑；Format 标题 + 结构 + 字数限制。',
    en: 'Scene skeleton: Role senior writer; Task lead with the conclusion, back with points; Format headline + structure + length cap.',
  },
  'writing-email': {
    zh: '场景骨架：Role 商务沟通者；Task 目的→称呼→正文→结尾；Format 语气 + 篇幅 + 附件说明。',
    en: 'Scene skeleton: Role business communicator; Task purpose → greeting → body → sign-off; Format tone + length + attachments.',
  },
  'writing-copy': {
    zh: '场景骨架：Role 品牌文案；Task 核心卖点→行动号召；Format 标题 + 正文 + 备选标题。',
    en: 'Scene skeleton: Role brand copywriter; Task key selling points → call to action; Format headline + body + alternatives.',
  },
  'writing-translate': {
    zh: '场景骨架：Role 专业译者；Task 保义→通顺→术语一致；Format 译文 + 关键术语表。',
    en: 'Scene skeleton: Role professional translator; Task faithful → fluent → consistent terms; Format translation + glossary.',
  },
  'writing-creative': {
    zh: '场景骨架：Role 创作者；Task 题材→风格→结构；Format 篇幅 + 分节。',
    en: 'Scene skeleton: Role writer; Task genre → style → structure; Format length + sections.',
  },
  'writing-polish': {
    zh: '场景骨架：Role 编辑；Task 保义→调语气→顺表达；Format 修改前后对照 + 改动理由。',
    en: 'Scene skeleton: Role editor; Task keep meaning → adjust tone → smooth wording; Format before/after + reasons.',
  },
  'writing-resume': {
    zh: '场景骨架：Role 职业顾问；Task 经历→量化→匹配岗位；Format 结构 + 要点 + 篇幅限制。',
    en: 'Scene skeleton: Role career advisor; Task experience → quantify → match the role; Format structure + bullets + length cap.',
  },
  'writing-speech': {
    zh: '场景骨架：Role 演讲稿作者；Task 主题→结构→口语化；Format 分节 + 时长。',
    en: 'Scene skeleton: Role speechwriter; Task theme → structure → spoken style; Format sections + duration.',
  },
  'writing-presentation': {
    zh: '场景骨架：Role 演示内容架构师；Task 明确受众与目的→搭建内容框架→逐页结构→视觉与话术要点；Format 内容框架 + 页面结构 + 设计建议 + 演示话术。',
    en: 'Scene skeleton: Role presentation content architect; Task audience & purpose → content framework → per-page structure → visual & delivery tips; Format content framework + page structure + design tips + delivery notes.',
  },
  'analysis-data': {
    zh: '场景骨架：Role 数据分析师；Task 清洗→指标→趋势→结论；Format 结论先行 + 图表/数据支撑。',
    en: 'Scene skeleton: Role data analyst; Task clean → metrics → trends → conclusion; Format conclusion first + charts/data.',
  },
  'analysis-research': {
    zh: '场景骨架：Role 研究员；Task 资料→框架→论证→结论；Format 引用来源 + 局限性。',
    en: 'Scene skeleton: Role researcher; Task sources → framework → argument → conclusion; Format citations + limitations.',
  },
  'analysis-review': {
    zh: '场景骨架：Role 评估者；Task 明确标准→逐项对比→结论；Format 评分表 + 依据。',
    en: 'Scene skeleton: Role evaluator; Task criteria → compare → verdict; Format scorecard + evidence.',
  },
  'analysis-forecast': {
    zh: '场景骨架：Role 预测分析师；Task 依据→模型→区间；Format 结论 + 置信度 + 风险。',
    en: 'Scene skeleton: Role forecast analyst; Task evidence → model → range; Format conclusion + confidence + risks.',
  },
  'ops-deploy': {
    zh: '场景骨架：Role 运维工程师；Task 环境→步骤→验证；Format 命令 + 预期输出 + 回滚。',
    en: 'Scene skeleton: Role ops engineer; Task environment → steps → verify; Format commands + expected output + rollback.',
  },
  'ops-install': {
    zh: '场景骨架：Role 运维工程师；Task 环境检查→安装→验证；Format 命令 + 注意事项。',
    en: 'Scene skeleton: Role ops engineer; Task check env → install → verify; Format commands + caveats.',
  },
  'ops-troubleshoot': {
    zh: '场景骨架：Role 排查专家；Task 定位→根因→解决；Format 排查步骤 + 证据 + 修复。',
    en: 'Scene skeleton: Role troubleshooter; Task locate → root cause → resolve; Format steps + evidence + fix.',
  },
  'ops-maintain': {
    zh: '场景骨架：Role 运维工程师；Task 巡检→备份→告警处理；Format 检查清单 + 计划。',
    en: 'Scene skeleton: Role ops engineer; Task inspect → backup → alert handling; Format checklist + schedule.',
  },
}

/**
 * Render a ready-to-fill four-section template for a subcategory (drives the
 * `/template <scene>` quick command — no model call). The scene skeleton is
 * quoted as reference, then a fillable Role/Task/Context/Format skeleton.
 * D-4 修复：占位符与主模板（templates.ts）一致——中英共用中文占位符。
 */
export function renderSceneTemplate(subtype: TaskSubtype, en: boolean): string {
  const skeleton = en ? SUB_TOPIC_TEMPLATES[subtype].en : SUB_TOPIC_TEMPLATES[subtype].zh
  const hint = en ? 'Scene skeleton reference: ' : '场景骨架参考：'
  const fillable = `## Role\n{{角色}}\n\n## Task\n{{任务}}\n\n## Context\n{{背景与约束}}\n\n## Format\n{{输出格式}}\n`
  return `${hint}${skeleton}\n\n${fillable}`
}

/**
 * Match a `/template` query against subcategory keys and their zh/en labels.
 * Returns the best-matching subcategory or `undefined`.
 */
export function matchScene(query: string): TaskSubtype | undefined {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return undefined
  let best: TaskSubtype | undefined
  let bestScore = 0
  for (const subtype of Object.keys(SUB_TOPIC_TEMPLATES) as TaskSubtype[]) {
    const zh = subtypeLabel(subtype, false)
    const en = subtypeLabel(subtype, true)
    let score = 0
    if (subtype.includes(q)) score = 3
    else if (en.includes(q) || zh.toLowerCase().includes(q)) score = 2
    else if (subtypeKeywords(subtype).some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()))) score = 1
    if (score > bestScore) {
      bestScore = score
      best = subtype
    }
  }
  return best
}

/** Section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS = `段落结构：
- 用四个段落组织结果，标题固定为英文：## Role、## Task、## Context、## Format。
- 全文精炼：一个要点一句话；正文按句断行，段落间空一行。
- 按任务复杂度组织：简单任务不拆步骤、不硬凑全部要素；复杂任务才分层展开。`

/** Plain-style structure paragraph — empty (template skeleton provides the essential output rule). */
const STRUCTURE_PLAIN = ``

/** Section-mode pre-output self-check.
 *  P-E（1.6.8）：六问压两问——「长度是否足以直接执行」这类问句会催写满；
 *  改为正向长度观「在锚点内说清即止」。细则性检查（角色公式/虚构/断行）由
 *  结构块与失败诊断路径承担，自查只保留形态与成本两条。 */
const SELFCHECK_SECTIONS = `- 输出前自查：四段标题是否齐全且各有实质内容，有无虚构、空话与重复？在长度锚点内说清即止——不凑满字数，也不缺执行要素。`

/** Plain-mode pre-output self-check — empty (template keeps the prompt minimal). */
const SELFCHECK_PLAIN = ``

/** Role/Task/Goal structure paragraph (1.6.5, parseable three-element form). */
const STRUCTURE_RTG = `输出结构（角色/任务/目标）：
- 用三行标签组织结果，标签为中文：角色：、任务：、目标：。角色一句定位执行主体；任务给动词与完成标准；目标合并受众约束与产出规格。
- 全文精炼：一个要点一句话；正文按句断行，段落间空一行。
- 按任务复杂度组织：简单任务不拆步骤、不硬凑全部要素；复杂任务才分层展开。`

/** Role/Task/Goal pre-output self-check (see SELFCHECK_SECTIONS for P-E rationale). */
const SELFCHECK_RTG = `- 输出前自查：角色：/任务：/目标：三行标签是否齐全且各有实质内容，有无虚构、空话与重复？在长度锚点内说清即止——不凑满字数，也不缺执行要素。`

/** English section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS_EN = `Section structure:
- Organize the result into four sections, with headings fixed in English: ## Role, ## Task, ## Context, ## Format.
- Keep it terse: one point per sentence; break lines by sentence with a blank line between paragraphs.
- Scale with complexity: skip step breakdowns and unused elements for simple tasks; expand in layers only for complex ones.`

/** English plain-style structure paragraph — empty. */
const STRUCTURE_PLAIN_EN = ``

/** English section-mode pre-output self-check. */
const SELFCHECK_SECTIONS_EN = `- Self-check before output: are all four headings present with substantive content, free of invented facts and filler? Stay within the length anchor — never pad to fill it, never drop an execution essential.`

/** English plain-mode pre-output self-check — empty. */
const SELFCHECK_PLAIN_EN = ``

/** Role/Task/Goal structure paragraph (1.6.5, parseable three-element form). */
const STRUCTURE_RTG_EN = `Output structure (Role / Task / Goal):
- Organize the result into three labeled lines, with labels fixed in English: Role:, Task:, Goal:. Role pins the executor; Task gives verbs and completion criteria; Goal merges audience, constraints, and the output spec.
- Keep it terse: one point per sentence; break lines by sentence with a blank line between paragraphs.
- Scale with complexity: skip step breakdowns and unused elements for simple tasks; expand in layers only for complex ones.`

/** Role/Task/Goal pre-output self-check (1.6.5). */
const SELFCHECK_RTG_EN = `- Self-check before output: are the Role:/Task:/Goal: labels present with substantive content, free of invented facts and filler? Stay within the length anchor — never pad to fill it, never drop an execution essential.`

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
import { toRoleTaskGoal } from './validate.js'
import { buildSituationProfile, detectMeasurable, detectTaskSubtype, extractMainVerbObject, renderSituationBlock, subtypeKeywords, subtypeLabel, type GoalDrift, type SituationProfile, type SituationProfileLevel, type TaskSubtype } from './situation.js'

/**
 * Built-in few-shot examples (1 pair per task type × language). Injected when
 * the caller provides no explicit `examples` — the matched task-type pair is
 * shown so the model has a concrete shape to follow (Workbuddy-style
 * "with example" experience). Explicit `examples` always win over these.
 */
const BUILTIN_EXAMPLES: Record<MetaLanguage, Record<Exclude<TaskType, 'other'>, PromptExample>> = {
  zh: {
    code: {
      input: '写一个 Python 脚本读取 CSV 并按指定列求和',
      output: '## Role\n资深 Python 工程师，擅长 pandas。\n\n## Task\n编写脚本读取 CSV 并按指定列求和，输出结果文件；脚本须可直接运行并处理缺失值。\n\n## Context\n输入 CSV 路径；输出结果 CSV；不修改原文件。\n\n## Format\n完整可运行的 .py 代码 + 顶部使用说明（依赖、运行命令），不超过 200 行。',
    },
    writing: {
      input: '写一份新产品发布公告',
      output: '## Role\n资深品牌文案撰稿人。\n\n## Task\n写一份 200 字内的新产品发布公告，突出核心卖点并给出行动号召。\n\n## Context\n面向潜在用户；语气专业热情；不夸大功能。\n\n## Format\n标题 + 正文段落，附 3 个备选标题。',
    },
    analysis: {
      input: '分析这份销售数据的趋势',
      output: '## Role\n数据分析师，擅长趋势解读。\n\n## Task\n分析给定销售数据：识别整体趋势、显著波动及其可能原因，并给出结论。\n\n## Context\n只基于数据说话，不臆测；结论先行。\n\n## Format\n结论先行 + 支撑数据点 + 风险提示，200 字内。',
    },
    ops: {
      input: '帮我部署这个服务到服务器',
      output: '## Role\n资深运维工程师，熟悉 Linux 与 Nginx。\n\n## Task\n给出部署步骤：环境准备、代码上传、服务配置与启动验证；按顺序执行，每步含验证命令。\n\n## Context\n目标服务器为 Ubuntu；服务基于 Node.js；不做未说明的改动。\n\n## Format\n分步清单（每步：命令 + 预期输出），附回滚方案。',
    },
  },
  en: {
    code: {
      input: 'Write a Python script to read a CSV and sum by a given column',
      output: '## Role\nSenior Python engineer, proficient in pandas.\n\n## Task\nWrite a script that reads a CSV, sums by the given column, and writes a result file; the script must run as-is and handle missing values.\n\n## Context\nInput: local CSV path; output: result CSV; never modify the original file.\n\n## Format\nA complete runnable .py file plus a short header (dependencies, run command), under 200 lines.',
    },
    writing: {
      input: 'Write a product launch announcement',
      output: '## Role\nSenior brand copywriter.\n\n## Task\nWrite a launch announcement within 200 words that highlights the key selling points and ends with a call to action.\n\n## Context\nFor potential customers; professional yet warm tone; no exaggerated claims.\n\n## Format\nHeadline + body paragraphs, plus 3 alternative headlines.',
    },
    analysis: {
      input: 'Analyze the trend in this sales data',
      output: '## Role\nData analyst skilled at trend interpretation.\n\n## Task\nAnalyze the provided sales data: identify the overall trend, notable swings and their likely causes, and state the conclusion.\n\n## Context\nBase every claim on the data; no speculation; lead with the conclusion.\n\n## Format\nConclusion first, then supporting data points and caveats, within 200 words.',
    },
    ops: {
      input: 'Deploy this service to the server',
      output: '## Role\nSenior DevOps engineer, familiar with Linux and Nginx.\n\n## Task\nProvide deployment steps: environment prep, code upload, service config, and startup verification; execute in order, each step with a verification command.\n\n## Context\nTarget: Ubuntu server; the service is Node.js based; make no changes beyond what is stated.\n\n## Format\nA step-by-step checklist (command + expected output per step), with a rollback plan.',
    },
  },
}

/**
 * Subtype-level built-in examples (1.5.4): a more specific pair wins over the
 * task-type pair when the subtype is detected. `code-bugfix` ships the
 * "root cause → minimal fix → regression check" shape (1.5.4);
 * `analysis-review` ships a "structured evaluation" shape (1.5.7) that the
 * generic `analysis` example (trend reading) does not cover. Explicit
 * `examples` still always win.
 */
const BUILTIN_SUBTYPE_EXAMPLES: Record<MetaLanguage, Partial<Record<TaskSubtype, readonly PromptExample[]>>> = {
  zh: {
    'code-bugfix': [
      {
        input: '定位并修复 @src/cache.ts 的报错',
        output: '## Role\n资深 TypeScript 工程师，精通类型检查与缓存模块设计，先保证可运行再优化。\n\n## Task\n对 @src/cache.ts 做完整错误诊断与最小修复：静态检查定位全部报错点并逐条列出类型与触发条件→最小修复（导出接口、函数签名、缓存语义不变，改动附依据）→跑 tsc --noEmit 与相关单测验证。\n\n## Context\n未提供具体报错与环境——无法精确定位时取最保守修复，说明推断依据。\n\n## Format\n①根因分析（短条目）②改动点（修改前后对比）③测试结果；代码可直接运行。',
      },
    ],
    'analysis-review': [
      {
        input: '评估 localTemplate 本地直出的覆盖面与边界',
        output: '## Role\n资深提示词插件架构师，熟悉 localTemplate 本地直出机制与 token 成本模型。\n\n## Task\n评估本地直出的覆盖面与边界：梳理门控规则（子类命中＋可抽取信号）→划清可直出与必须走 LLM 的边界→评估「本地直出＋LLM 精修」混合档收益。\n\n## Context\n直出为零 token 零延迟；本地路径不读上下文。\n\n## Format\n结构化清单：①判定标准对照 ②可直出 vs 必须 LLM 边界 ③关闭上下文感知的条件与风险 ④按优先级列优化项。',
      },
      {
        // 1.6.4：模板四段诊断（Role/Task/Context/Format 逐段评估重构）。
        // 用词规避 1.6.3 hasMetaContent 模式（「优化标准」「核心约束逻辑」
        // 「定"谁来说"」等），防止模型模仿输出元内容附录。
        input: '诊断并重构一个模板的 Role、Task、Context、Format 四段，输出优化方案文档',
        output: '## Role\n资深提示词工程专家，熟悉四段设计约束与可检验标准，先诊断再重构。\n\n## Task\n逐段诊断并重构给定模板：指出每段具体缺陷及影响→以四段定位框架建立判定标准→给出各段优化方案（目标表述、改写示例、补充约束）→输出完整文档。\n\n## Context\n以四段设计哲学为基准；避免空泛建议，每个优化点对应可执行检查清单。\n\n## Format\nMarkdown 文档：模板总览、逐段分析（问题-原因-方案）、优化后的完整模板正文、前后对比表。',
      },
    ],
    'writing-report': [
      {
        input: '写一份周报，总结本周进展和下周计划',
        output: '## Role\n资深项目助理，擅长周报撰写，结论先行、要点支撑。\n\n## Task\n总结本周进展与下周计划：先列本周完成事项与关键结果，再写下周计划与待办风险。\n\n## Context\n面向团队与上级，聚焦进展与待办；无数据时如实说明状态。\n\n## Format\n分节列出、每项一行；标题 + 结构 + 篇幅控制。',
      },
      {
        // B3a 变体：述职报告（成果量化导向，与周报的事务性结构区分）。
        input: '写一份述职报告，突出本季度成果',
        output: '## Role\n资深项目助理，擅长述职报告，成果量化、复盘到位。\n\n## Task\n撰写述职报告：量化本季度成果→复盘得失→给出下阶段规划。\n\n## Context\n面向上级与评审，突出成果与影响；数据尽量量化。\n\n## Format\n成果亮点（量化）+ 复盘 + 规划，分节列出。',
      },
    ],
    'writing-email': [
      {
        input: '写一封催款邮件给客户',
        output: '## Role\n专业客户经理，语气礼貌而立场坚定。\n\n## Task\n向客户发送催款邮件：说明账单到期情况、礼貌提醒付款、附联系方式与期限。\n\n## Context\n面向长期客户，维护合作关系；语气委婉但要求明确。\n\n## Format\n主题行 + 邮件正文 + 结尾署名。',
      },
    ],
    'writing-copy': [
      {
        input: '写一条新品上市的推广文案',
        output: '## Role\n资深营销文案，擅长抓核心卖点与行动号召。\n\n## Task\n撰写新品上市推广文案：提炼核心卖点、面向目标人群、给出明确行动号召。\n\n## Context\n面向目标消费者，投放于社交媒体；语气有感染力、篇幅精炼。\n\n## Format\n标题 + 正文 + 备选标题。',
      },
      {
        // 1.6.7 P1：个人简介/工作经历文案变体（求职场景，贴小儿推拿师等职业介绍）。
        input: '写一份小儿推拿师的工作经历介绍文案，用于个人简介或求职',
        output: '## Role\n资深文案兼职业顾问，把专业资质与经历转化为有说服力的介绍。\n\n## Task\n撰写工作经历介绍文案：先梳理核心亮点（资质/年限/擅长），再分层叙述经历与能力，最后给出常见问题调理方案。\n\n## Context\n面向家长与机构负责人；突出认证、年限、成功案例与反馈。\n\n## Format\n四部分：概况资质 / 经历能力（含数据案例）/ 职业分析与手法特色 / 调理方案（分症状列要点）；300-500 字。',
      },
    ],
    'writing-resume': [
      {
        input: '帮我写一份求职用的个人介绍',
        output: '## Role\n职业顾问，擅长把经历转化为量化亮点。\n\n## Task\n把求职者经历整理为个人介绍：经历→量化→匹配目标岗位。\n\n## Context\n面向招聘方，突出与目标岗位的匹配度；需提供岗位方向与亮点数据。\n\n## Format\n结构 + 要点 + 篇幅限制。',
      },
    ],
    'writing-presentation': [
      {
        input: '帮我生成个人介绍PPT',
        output: '## Role\n演示内容架构师，面向受众组织信息、突出数据与成果。\n\n## Task\n搭建个人介绍PPT：明确受众与目的→搭建内容框架→逐页结构→视觉与话术要点。\n\n## Context\n面向面试官或听众；说明场合（求职/述职/汇报）与时长；突出量化成果。\n\n## Format\n内容框架 + 页面结构 + 设计建议 + 演示话术。',
      },
      {
        // B3a 变体：产品介绍 PPT（卖点/竞品/客户收益导向，与个人介绍区分）。
        input: '帮我做一份产品介绍PPT',
        output: '## Role\n演示内容架构师，面向客户讲清产品价值。\n\n## Task\n搭建产品介绍PPT：核心卖点→产品演示→竞品对比→客户收益。\n\n## Context\n面向目标客户或合作方；说明产品类型与演示时长。\n\n## Format\n内容框架 + 页面结构 + 演示要点。',
      },
      {
        // B3b 精选变体：融资路演 PPT（市场/商业模式/融资需求导向，结构差异显著）。
        input: '帮我做一份融资路演PPT',
        output: '## Role\n演示内容架构师，面向投资人讲清市场机会与商业模式。\n\n## Task\n搭建融资路演PPT：市场机会→商业模式→团队与数据→融资需求与用途。\n\n## Context\n面向投资人；说明融资阶段与金额；突出增长数据与壁垒。\n\n## Format\n内容框架 + 页面结构 + 演示要点。',
      },
    ],
    'code-script': [
      {
        input: '写一个 Python 脚本批量重命名文件',
        output: '## Role\n资深 Python 工程师，先保证可运行再优化。\n\n## Task\n编写脚本批量重命名文件：定义命名规则、处理异常与冲突、输出执行日志。\n\n## Context\n输入目录与命名规则；不修改原文件；说明依赖与运行环境。\n\n## Format\n完整可运行的 .py 代码 + 顶部使用说明（依赖、运行命令）。',
      },
    ],
    'analysis-data': [
      {
        input: '分析这份销售数据的趋势',
        output: '## Role\n资深数据分析师，结论先行、数据支撑。\n\n## Task\n分析销售数据趋势：清洗→关键指标→趋势判断→结论与建议。\n\n## Context\n说明数据来源与时间范围；面向业务决策者。\n\n## Format\n结论先行 + 图表/数据支撑 + 建议清单。',
      },
    ],
    'ops-deploy': [
      {
        input: '帮我部署这个服务到服务器',
        output: '## Role\n资深运维工程师，先确认环境再操作。\n\n## Task\n部署服务到目标服务器：确认环境→按清单执行→完成后自检。\n\n## Context\n说明目标环境与服务类型；操作需可回滚、有验证步骤。\n\n## Format\n命令清单 + 验证步骤 + 回滚说明。',
      },
      {
        // B3a 变体：生产环境发布（灰度+回滚预案，与通用部署区分）。
        input: '帮我发布到生产环境',
        output: '## Role\n资深运维工程师，生产发布慎之又慎。\n\n## Task\n发布到生产环境：变更前备份→灰度放量→监控验证→异常回滚。\n\n## Context\n说明服务类型与变更内容；含回滚预案与灰度比例。\n\n## Format\n发布步骤（灰度）+ 监控项 + 回滚预案。',
      },
    ],
    'code-review': [
      {
        input: '帮我 review 一下这段代码',
        output: '## Role\n资深代码审查员，按正确性、可读性、性能逐项把关。\n\n## Task\n审查给定代码：逐项检查正确性、可读性、性能与边界情况，给出问题清单与修改建议。\n\n## Context\n说明代码用途与上下文；优先标注阻塞性问题。\n\n## Format\n问题清单（严重度 + 位置 + 建议）+ 总结。',
      },
    ],
    'ops-troubleshoot': [
      {
        input: '帮我排查这个服务启动失败的问题',
        output: '## Role\n资深运维工程师，按日志→定位→修复的顺序排查。\n\n## Task\n排查服务启动失败：收集日志→定位根因→给出修复方案与验证步骤。\n\n## Context\n说明服务类型与错误现象；先做最小验证再改。\n\n## Format\n排查步骤 + 根因 + 修复方案 + 验证。',
      },
    ],
    'writing-polish': [
      {
        input: '帮我润色这段文案',
        output: '## Role\n资深编辑，保持原意、优化表达。\n\n## Task\n润色给定文案：保持原意→调整语气→优化措辞与节奏。\n\n## Context\n说明使用场景与目标读者；保留关键信息。\n\n## Format\n润色后全文 + 改动说明。',
      },
    ],
    'writing-translate': [
      {
        input: '把这段中文翻译成英文',
        output: '## Role\n专业翻译，兼顾准确与地道。\n\n## Task\n把给定内容翻译为目标语言：保持术语准确、语气一致、句式自然。\n\n## Context\n说明文体与用途；术语有约定时优先遵循。\n\n## Format\n译文 + 术语表（如有）。',
      },
    ],
    'analysis-research': [
      {
        input: '调研一下这个行业的竞争格局',
        output: '## Role\n行业研究员，资料→框架→论证→结论。\n\n## Task\n调研行业竞争格局：收集资料→搭建框架→论证→给出结论与依据。\n\n## Context\n说明调研范围与目标；引用来源、注明局限。\n\n## Format\n结论先行 + 依据 + 来源引用 + 局限性。',
      },
    ],
  },
  en: {
    'code-bugfix': [
      {
        input: 'Locate and fix the errors in @src/cache.ts',
        output: '## Role\nSenior TypeScript engineer, proficient in type checking and cache-module design; make it run first, then optimize.\n\n## Task\nDiagnose and minimally fix @src/cache.ts: statically locate every error and list each type and trigger condition → apply the minimal fix keeping exported interfaces and cache semantics unchanged, annotating each change → run tsc --noEmit and related tests.\n\n## Context\nNo concrete error message or environment given — apply the most conservative fix when the root cause is unclear, stating the inference basis.\n\n## Format\n① root-cause analysis (short bullets) ② changes (before/after) ③ test results; include a runnable complete snippet.',
      },
    ],
    'analysis-review': [
      {
        input: 'Assess the coverage and boundaries of localTemplate local rendering',
        output: '## Role\nSenior prompt-plugin architect, familiar with the localTemplate local-render mechanism and the token cost model.\n\n## Task\nAssess the coverage and boundaries of local rendering: walk the gate rules (subcategory match + extractable signals) → draw the renderable-vs-LLM boundary → weigh the hybrid "local render + LLM refine" benefit.\n\n## Context\nLocal render costs zero tokens with zero latency; it never reads conversation context.\n\n## Format\nStructured checklist: ① render criteria ② renderable-vs-LLM boundary ③ when disabling context-awareness is appropriate ④ prioritized next steps.',
      },
      {
        input: 'Diagnose and restructure the Role, Task, Context and Format sections of a template, outputting an optimization document',
        output: '## Role\nSenior prompt-engineering expert, familiar with the design constraints and testability criteria of the four sections; diagnose first, then restructure.\n\n## Task\nDiagnose and restructure the template section by section: identify concrete defects of each section and their impact → build criteria on the four-section positioning frame → give per-section optimizations → output the complete document.\n\n## Context\nBenchmark against the four-section design philosophy; every optimization point maps to an executable checklist.\n\n## Format\nMarkdown document: overview, per-section analysis (problem → cause → optimization), the restructured template in full, before/after comparison.',
      },
    ],
    'writing-report': [
      {
        input: "Write a weekly report summarizing this week's progress and next week's plan",
        output: '## Role\nSenior project assistant, skilled at concise, bullet-driven weekly reports.\n\n## Task\nSummarize this week\'s progress and next week\'s plan: list completed items with key results first, then next week\'s plan and risks.\n\n## Context\nFor the team and leadership, focused on progress and todos; state status honestly when no data is available.\n\n## Format\nSectioned list, one item per line; title + structure + length control.',
      },
      {
        // B3a variant: performance review (results-quantified, distinct from the weekly report).
        input: "Write a performance review report highlighting this quarter's results",
        output: '## Role\nSenior project assistant, skilled at quantified, review-driven performance reports.\n\n## Task\nWrite the performance review: quantify this quarter\'s results → review wins and losses → outline next-phase plans.\n\n## Context\nFor management and the review board, emphasizing results and impact; quantify wherever possible.\n\n## Format\nQuantified highlights + review + plans, in sections.',
      },
    ],
    'writing-email': [
      {
        input: 'Write a payment reminder email to a client',
        output: '## Role\nProfessional account manager, polite but firm.\n\n## Task\nSend a payment reminder: state the due invoice, politely request payment, and include contact info and deadline.\n\n## Context\nFor a long-term client, preserving the relationship; tactful yet explicit.\n\n## Format\nSubject line + email body + closing signature.',
      },
    ],
    'writing-copy': [
      {
        input: 'Write a launch promo for a new product',
        output: '## Role\nSenior copywriter, skilled at surfacing core selling points and calls to action.\n\n## Task\nWrite a product-launch promo: distill the core selling point, target the audience, and give a clear call to action.\n\n## Context\nFor target consumers on social media; an engaging tone with a tight length.\n\n## Format\nHeadline + body + alternative headlines.',
      },
      {
        // 1.6.7 P1: work-experience/profile copy variant (job-seeking contexts).
        input: 'Write a work-experience profile for a pediatric massage therapist, for a bio or a job application',
        output: '## Role\nSenior copywriter and career consultant, turning credentials and experience into a persuasive profile.\n\n## Task\nWrite a work-experience profile: surface core highlights (credentials / years / specialties), walk through experience and capabilities, then give treatment plans for common problems.\n\n## Context\nFor parents and clinic managers; highlight certifications, years, success cases and feedback.\n\n## Format\nFour parts: profile & credentials / experience & capabilities (with data and cases) / professional analysis & technique signature / treatment plans (per symptom); 300-500 words.',
      },
    ],
    'writing-resume': [
      {
        input: 'Write a personal introduction for a job application',
        output: '## Role\nCareer advisor, skilled at turning experience into quantified highlights.\n\n## Task\nTurn the applicant\'s experience into a personal introduction: experience → quantification → match to the target role.\n\n## Context\nFor recruiters, emphasizing fit with the target role; needs the role direction and highlight metrics.\n\n## Format\nStructure + bullets + length cap.',
      },
    ],
    'writing-presentation': [
      {
        input: 'Create a personal-introduction presentation (PPT)',
        output: '## Role\nPresentation content architect, organizing information for the audience and highlighting data and outcomes.\n\n## Task\nBuild a personal-introduction deck: audience & purpose → content framework → per-page structure → visual & delivery tips.\n\n## Context\nFor interviewers or an audience; state the occasion (interview/review/report) and duration; highlight quantified outcomes.\n\n## Format\nContent framework + page structure + design tips + delivery notes.',
      },
      {
        // B3a variant: product-introduction deck (selling points / competitors / customer value).
        input: 'Create a product-introduction presentation (PPT)',
        output: '## Role\nPresentation content architect, making the product value clear to customers.\n\n## Task\nBuild a product-introduction deck: core selling points → product demo → competitor comparison → customer benefits.\n\n## Context\nFor target customers or partners; state the product type and the presentation duration.\n\n## Format\nContent framework + page structure + delivery notes.',
      },
      {
        // B3b curated variant: fundraising pitch deck (market / business model / funding ask).
        input: 'Create a fundraising pitch-deck presentation',
        output: '## Role\nPresentation content architect, making the market opportunity and business model clear to investors.\n\n## Task\nBuild a fundraising pitch deck: market opportunity → business model → team and traction → funding ask and use of funds.\n\n## Context\nFor investors; state the funding stage and amount; highlight growth data and moats.\n\n## Format\nContent framework + page structure + delivery notes.',
      },
    ],
    'code-script': [
      {
        input: 'Write a Python script to batch-rename files',
        output: '## Role\nSenior Python engineer; make it run first, then optimize.\n\n## Task\nWrite a batch-rename script: define the naming rule, handle exceptions and conflicts, and log the execution.\n\n## Context\nInput directory and naming rule; never modify the original files; state dependencies and the runtime.\n\n## Format\nA directly runnable .py file + usage notes at the top (dependencies, run command).',
      },
    ],
    'analysis-data': [
      {
        input: 'Analyze the trend in this sales data',
        output: '## Role\nSenior data analyst; lead with the conclusion, back it with data.\n\n## Task\nAnalyze the sales trend: clean → key metrics → trend judgment → conclusion and recommendations.\n\n## Context\nState the data source and time range; for business decision-makers.\n\n## Format\nConclusion first + charts/data + a recommendation list.',
      },
    ],
    'ops-deploy': [
      {
        input: 'Deploy this service to a server',
        output: '## Role\nSenior ops engineer; verify the environment before touching anything.\n\n## Task\nDeploy the service to the target server: confirm the environment → follow the checklist → self-check when done.\n\n## Context\nState the target environment and service type; operations must be reversible with verification steps.\n\n## Format\nCommand checklist + verification steps + rollback notes.',
      },
      {
        // B3a variant: production release (canary + rollback plan, distinct from a generic deploy).
        input: 'Release this service to production',
        output: '## Role\nSenior ops engineer, extra cautious with production releases.\n\n## Task\nRelease to production: back up before the change → canary rollout → monitor and verify → roll back on anomalies.\n\n## Context\nState the service type and the change scope; include the rollback plan and the canary ratio.\n\n## Format\nRelease steps (canary) + monitoring items + rollback plan.',
      },
    ],
    'code-review': [
      {
        input: 'Review this code for me',
        output: '## Role\nSenior code reviewer, checking correctness, readability and performance item by item.\n\n## Task\nReview the given code: check correctness, readability, performance and edge cases, then list the issues with fix suggestions.\n\n## Context\nState what the code does and its context; flag blocking issues first.\n\n## Format\nIssue list (severity + location + suggestion) + a summary.',
      },
    ],
    'ops-troubleshoot': [
      {
        input: 'Troubleshoot why this service fails to start',
        output: '## Role\nSenior ops engineer, following logs → root cause → fix.\n\n## Task\nTroubleshoot the failed startup: gather logs → locate the root cause → provide a fix and verification steps.\n\n## Context\nState the service type and the error symptom; verify the smallest change first.\n\n## Format\nTroubleshooting steps + root cause + fix + verification.',
      },
    ],
    'writing-polish': [
      {
        input: 'Polish this copy for me',
        output: '## Role\nSenior editor, preserving the meaning while improving the expression.\n\n## Task\nPolish the given copy: keep the meaning → adjust the tone → refine wording and rhythm.\n\n## Context\nState the use case and target reader; keep the key information.\n\n## Format\nPolished full text + a change note.',
      },
    ],
    'writing-translate': [
      {
        input: 'Translate this Chinese text into English',
        output: '## Role\nProfessional translator, balancing accuracy and naturalness.\n\n## Task\nTranslate the given content into the target language: keep terms accurate, tone consistent and sentences natural.\n\n## Context\nState the register and purpose; follow established terminology when available.\n\n## Format\nTranslation + a terminology table (if any).',
      },
    ],
    'analysis-research': [
      {
        input: 'Research the competitive landscape of this industry',
        output: '## Role\nIndustry researcher, sources → framework → argument → conclusion.\n\n## Task\nResearch the competitive landscape: gather sources → build a framework → argue → give the conclusion with evidence.\n\n## Context\nState the research scope and goal; cite sources and note limitations.\n\n## Format\nConclusion first + evidence + source citations + limitations.',
      },
    ],
  },
}

/**
 * 过配门控（A1，1.6.8）：内置示例与原始指令主题几乎重合时不再注入该示例。
 * 根因实测：推拿文案指令命中为其定制的孪生示例后，输出逐字搬运示例内容
 * （「先梳理核心亮点，再分层叙述…」）——示例越像输入，克隆压力越大，
 * 「不要照抄」免责声明压不过 few-shot 模仿。判定用双条件，缺一不判过配：
 * 1. 覆盖率：|bigrams(示例input) ∩ bigrams(指令)| / |bigrams(示例input)| ≥ 阈值。
 *    不用 Jaccard——它会被长指令稀释（推拿对实测仅 ≈0.17，无法区分）；
 *    覆盖率直接衡量「示例被指令覆盖了多少」（推拿对 ≈0.56，无关对 <0.2）。
 * 2. 长度比：指令长度 > 示例 input × 比例阈值。指令携带了示例没有的细节时，
 *    示例只剩预制的内容决策，与用户需求纯竞争；而「帮我做一份融资路演PPT」
 *    这类与示例逐字一致的短语变体（长度比 ≈1）是刻意编码的理想结构，必须保留。
 */
const EXAMPLE_OVERFIT_CONTAINMENT = 0.45
const EXAMPLE_OVERFIT_LENGTH_RATIO = 1.3

function exampleOverfits(exampleInput: string, instruction: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const e = norm(exampleInput)
  const u = norm(instruction)
  if (e.length === 0 || u.length === 0) return false
  if (u.length <= e.length * EXAMPLE_OVERFIT_LENGTH_RATIO) return false
  const grams = (s: string): Set<string> => {
    const set = new Set<string>()
    if (s.length === 1) {
      set.add(s)
      return set
    }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ge = grams(e)
  const gu = grams(u)
  let overlap = 0
  for (const g of ge) if (gu.has(g)) overlap++
  return overlap / ge.size >= EXAMPLE_OVERFIT_CONTAINMENT
}

/** Pick the built-in example pair for a language + task type (+ subtype). */
function resolveBuiltinExamples(
  en: boolean,
  taskType: TaskType | undefined,
  subtype: TaskSubtype | undefined,
  instruction?: string,
): readonly PromptExample[] {
  // 过配门控只作用于内置回退路径；显式配置的 examples 是用户的明确选择，不过滤。
  const pick = (pairs: readonly PromptExample[]): readonly PromptExample[] =>
    instruction === undefined ? pairs : pairs.filter((p) => !exampleOverfits(p.input, instruction))
  const subtypeSet = en ? BUILTIN_SUBTYPE_EXAMPLES.en : BUILTIN_SUBTYPE_EXAMPLES.zh
  if (subtype !== undefined) {
    const sub = subtypeSet[subtype]
    if (sub !== undefined) {
      const kept = pick(sub)
      // 子类候选全被门控滤掉 → 回落大类示例继续过滤（大类更通用、主题重合更低），
      // 而不是注入空块：保住格式锚点，只丢克隆源。
      if (kept.length > 0) return kept
    }
  }
  const set = en ? BUILTIN_EXAMPLES.en : BUILTIN_EXAMPLES.zh
  const key = taskType !== undefined && taskType !== 'other' ? taskType : 'writing'
  return pick([set[key]])
}

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
  outputStyle: 'sections' | 'plain' | 'role-task-goal',
  metaLanguage: MetaLanguage,
  diagnosis: string | undefined,
  context: string | undefined,
  taskType: TaskType | undefined,
  maxOutputTokens: number | undefined,
  profile: SituationProfile | undefined,
  subtype: TaskSubtype | undefined,
  drift: GoalDrift | undefined,
  level: SituationProfileLevel | undefined,
  rawInput: string,
  builtinExamples?: boolean,
  compact?: boolean,
  sceneRefEnabled?: boolean,
): MetaBlocks {
  const pinned = language !== undefined && language !== 'auto' && language.length > 0
  const langRule = pinned ? `- 输出语言固定为：${language}。\n` : ''
  const extra = extraInstructions !== undefined && extraInstructions.trim().length > 0
    ? `${extraInstructions.trim()}\n`
    : ''
  const en = metaLanguage === 'en'
  // Explicit examples win; otherwise fall back to the built-in pair matched to
  // the task type and role-document language — unless `builtinExamples` is
  // explicitly false (1.4.6: short-instruction scenarios may want no example).
  // A1 过配门控只作用于内置回退：显式 examples 是用户的明确选择，不过滤。
  const effectiveExamples = examples !== undefined && examples.length > 0
    ? examples
    : (builtinExamples === false ? [] : resolveBuiltinExamples(en, taskType, subtype, rawInput))
  // role-task-goal（1.6.5 折叠注入）：内置示例为四段形态——RTG 模式下把示例
  // output 折叠为三要素标签再注入，作为三要素输出的 few-shot 引导
  // （plain 无标题形态仍禁用示例）。
  const exampleBlock = outputStyle !== 'plain' && effectiveExamples.length > 0
    ? `参考以下示例的格式与结构（示例仅为示范，内容必须根据用户实际指令重新撰写，禁止照搬示例内容）：\n${effectiveExamples
        .map((e, i) => {
          const out = outputStyle === 'role-task-goal' ? toRoleTaskGoal(e.output, en) : e.output
          return `示例 ${i + 1}：\n原始指令：${e.input}\n优化结果：\n${out}`
        })
        .join('\n\n')}\n`
    : ''
  const diagnosisBlock = diagnosis !== undefined && diagnosis.trim().length > 0
    ? (en
        ? `- The previous output had the following problems; this output must fix them: ${diagnosis.trim()}\n`
        : `- 上次输出存在以下问题，本次输出必须修正：${diagnosis.trim()}\n`)
    : ''
  // P-A 简单指令极简档：compact 时砍掉任务类型/场景参考/情境画像/自查四块，
  // 只留骨架＋输出规则＋结构块＋护栏＋原始指令。
  const taskTypeBlock = !compact && taskType !== undefined && taskType !== 'other'
    ? `${en ? TASKTYPE_EN[taskType] : TASKTYPE_ZH[taskType]}\n`
    : ''
  // B2 合并块（1.6.8）：子类提示＋角色参考＋场景骨架三块语义重叠——都在回答
  // 「这个任务长什么样」，压成一行场景参考。子类命中 → 标签+角色+骨架一行；
  // 仅大类命中 → 只保留角色参考行。ADR-009 内容级门控不变（仅命中时注入）。
  // sceneRefEnabled: false 时完全跳过场景参考注入（省 ~200 input tokens）。
  const sceneRefBlock =
    sceneRefEnabled !== false && !compact && subtype !== undefined && taskType !== undefined && taskType !== 'other'
      ? (en
          ? `- IMPORTANT: The scene reference below is INSPIRATION ONLY — expand it into a detailed, specific prompt. Do NOT echo or copy it verbatim.\n- Scene reference: 【${subtypeLabel(subtype, true)}】 · ${ROLE_LIBRARY[taskType].en} · ${SUB_TOPIC_TEMPLATES[subtype].en}\n`
          : `- 重要：以下场景参考仅为灵感来源——请将其展开为具体、详细的提示词，严禁逐字照搬。\n- 场景参考：【${subtypeLabel(subtype, false)}】类 · ${ROLE_LIBRARY[taskType].zh} · ${SUB_TOPIC_TEMPLATES[subtype].zh}\n`)
      : taskType !== undefined && taskType !== 'other'
        ? `${en ? ROLE_LIBRARY[taskType].en : ROLE_LIBRARY[taskType].zh}\n`
        : ''
  const lengthBlock = maxOutputTokens !== undefined && maxOutputTokens > 0
    ? (en
        ? `- Suggested output length: no more than ${maxOutputTokens} tokens (${lengthAnchor(maxOutputTokens, true)}). Soft guideline — be as concise as the task allows, never pad to fill it.\n`
        : `- 建议输出长度不超过 ${maxOutputTokens} token（${lengthAnchor(maxOutputTokens, false)}）。此为软约束：在覆盖完整的前提下尽量精简，不要刻意凑满。\n`)
    : ''
  // 情境块在 compact 档下保留：它承载会话级目标沿用与用户显式约束——是意图
  // 而非脚手架；短追问（「输出全文」）依赖它注入注册目标。
  const situationBlock = profile !== undefined ? renderSituationBlock(profile, en, drift, level) : ''
  return {
    structure: outputStyle === 'plain'
      ? (en ? STRUCTURE_PLAIN_EN : STRUCTURE_PLAIN)
      : outputStyle === 'role-task-goal'
        ? (en ? STRUCTURE_RTG_EN : STRUCTURE_RTG)
        : (en ? STRUCTURE_SECTIONS_EN : STRUCTURE_SECTIONS),
    selfCheck: compact
      ? ''
      : outputStyle === 'plain'
        ? (en ? SELFCHECK_PLAIN_EN : SELFCHECK_PLAIN)
        : outputStyle === 'role-task-goal'
          ? (en ? SELFCHECK_RTG_EN : SELFCHECK_RTG)
          : (en ? SELFCHECK_SECTIONS_EN : SELFCHECK_SECTIONS),
    langRule,
    extra,
    exampleBlock,
    diagnosis: diagnosisBlock,
    context: buildContextBlock(context ?? '', metaLanguage, outputStyle),
    taskType: `${taskTypeBlock}${sceneRefBlock}`,
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
 * 简单指令分档（P-A，1.6.8）：归一化后 ≤16 字符视为简单指令——系统提示词
 * 走极简档（不注入任务类型/场景参考/情境画像/自查），输出预算同步降档。
 * 依据「自由度匹配」原则：脚手架密度应与任务复杂度成正比，而不是对一切
 * 输入施加同密度规定。
 */
const COMPACT_TIER_MAX_CHARS = 16

export function isCompactInstruction(input: string): boolean {
  const norm = input.replace(/\s+/g, '').toLowerCase()
  return norm.length > 0 && norm.length <= COMPACT_TIER_MAX_CHARS
}

/**
 * Human-perceivable anchor paired with the token budget (B3, 1.6.8). zh uses
 * the plugin-conservative CJK ratio (~1.5 tokens per char, floored to 50);
 * en uses the common ~0.75 words/token heuristic (floored to 25 words). The
 * anchor deliberately under-shoots: a soft guideline that errs terse never
 * triggers truncation retries.
 */
function lengthAnchor(tokens: number, en: boolean): string {
  if (en) return `roughly ${Math.max(25, Math.floor((tokens * 0.75) / 25) * 25)} words`
  return `中文约 ${Math.max(50, Math.floor(tokens / 1.5 / 50) * 50)} 字以内`
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
  outputStyle: 'sections' | 'plain' | 'role-task-goal' = 'plain',
  metaLanguage: MetaLanguage = 'zh',
  diagnosis?: string,
  templates: TemplateSet = DEFAULT_TEMPLATES,
  context?: string,
  taskType?: TaskType,
  maxOutputTokens?: number,
  profile?: SituationProfile,
  level?: SituationProfileLevel,
  builtinExamples?: boolean,
  compact?: boolean,
  sceneRefEnabled?: boolean,
): string {
  const template = metaLanguage === 'en' ? templates.optimizeEn : templates.optimizeZh
  const resolvedProfile = profile ?? buildSituationProfile(input, context)
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, context, taskType ?? resolvedProfile.task.type, maxOutputTokens, resolvedProfile, resolvedProfile.task.subtype, undefined, level, input, builtinExamples, compact, sceneRefEnabled))
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
  outputStyle: 'sections' | 'plain' | 'role-task-goal' = 'plain',
  metaLanguage: MetaLanguage = 'zh',
  diagnosis?: string,
  templates: TemplateSet = DEFAULT_TEMPLATES,
  context?: string,
  taskType?: TaskType,
  maxOutputTokens?: number,
  profile?: SituationProfile,
  drift?: GoalDrift,
  level?: SituationProfileLevel,
  builtinExamples?: boolean,
  compact?: boolean,
  sceneRefEnabled?: boolean,
): string {
  const template = metaLanguage === 'en' ? templates.iterateEn : templates.iterateZh
  const resolvedProfile = profile ?? buildSituationProfile(instruction, context)
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, context, taskType ?? resolvedProfile.task.type, maxOutputTokens, resolvedProfile, resolvedProfile.task.subtype, drift, level, instruction, builtinExamples, compact, sceneRefEnabled))
  return rendered.replace(/\{\{上次结果\}\}|\{\{迭代指令\}\}/g, (match) =>
    match === '{{上次结果}}' ? lastResult : instruction,
  )
}