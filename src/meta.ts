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
  const { item, score } = bestScoreByKeywords(kinds.map((kind) => ({ kind, keywords: TASK_KEYWORDS[kind] })), lower)
  if (item === undefined) return 'other'
  // 1.5.5 歧义消解：写作动词（写/撰写/起草/编写/拟…）是写作类强信号——
  // 当它与 ops 类词（如「发布/上线」，1.5.2 新增）打平时，应判 writing
  // （「帮我写一份新产品发布公告」→ writing-copy，而非 ops-deploy）。
  // 仅在平局或 ops 未领先时应用，避免破坏「发布到生产环境」等纯运维指令
  // 的 ops 判定；code 类技术词优先不受影响（迭代顺序在前，平局仍 code 赢）。
  if (item.kind === 'ops' && score === 1 && WRITING_VERB_RE.test(lower)) {
    return 'writing'
  }
  return item.kind
}

/** Explicit writing verbs — strong writing-category signal (1.5.5 tie-break). */
const WRITING_VERB_RE = /写|撰写|起草|编写|拟写|草拟|润色|翻译/i

/** Per-category role/format hints injected as the `{{任务类型}}` block (zh). */
const TASKTYPE_ZH: Record<Exclude<TaskType, 'other'>, string> = {
  code: '任务类型提示：该指令检测为编程/开发类任务——角色定位应偏向相关领域的资深技术专家（如资深工程师、架构师），并在输出中明确输出语言、代码可运行性与必要的注释要求。\n角色写法建议：偏向能力导向——用"精通/熟悉/擅长…"描述技术栈与专长，比单纯"你是工程师"更可执行；能力陈述保持简短（一句为限）、与任务直接相关，不展开完整技术栈清单。\n区块侧重：Task 段与 Format 段强化（可运行性、交付物），Role 段一句简洁带过。',
  writing: '任务类型提示：该指令检测为写作/文案类任务——角色定位应偏向对应领域的资深撰稿人或编辑，并在输出中明确文体、篇幅、语气与目标读者。\n角色写法建议：偏向身份＋文体——给出身份（如"资深撰稿人"），并明确文体、篇幅与语气。\n区块侧重：Role 段与 Context 段强化（身份、受众、语气），Format 段保留。',
  analysis: '任务类型提示：该指令检测为分析/研究类任务——角色定位应偏向分析师或研究员，并在输出中明确结论先行、给出依据与数据来源、说明分析维度。\n角色写法建议：偏向身份＋方法——给出身份（如"分析师/研究员"），并说明分析方法（如"结论先行、数据支撑"）。\n区块侧重：Task 段与 Context 段强化（方法、数据来源），Format 段结论先行。',
  ops: '任务类型提示：该指令检测为执行/操作类任务——角色定位应偏向执行者或运维角色，并在输出中明确步骤顺序、前置条件与完成检查。\n角色写法建议：偏向行为约束＋步骤——说明执行边界与步骤顺序（如"先确认环境、按清单操作、完成后自检"）。\n区块侧重：Task 段与 Format 段强化（步骤、命令、回滚），Role 段简洁。',
}

/** Per-category role/format hints injected as the `{{任务类型}}` block (en). */
const TASKTYPE_EN: Record<Exclude<TaskType, 'other'>, string> = {
  code: 'Task-type hint: this instruction is detected as a coding/development task — lean the role toward a senior technical expert (e.g. senior engineer, architect), and make the output explicit about the language, runnability of the code, and any required comments.\nRole-writing tip: lean capability-oriented — describe the stack and expertise with "proficient in / skilled at / familiar with…" rather than a bare "you are an engineer"; keep the capability statement brief (one sentence), directly relevant to the task, and free of a full technology-stack list.\nSection emphasis: strengthen the Task and Format sections (runnability, deliverable); keep the Role section to one concise sentence.',
  writing: 'Task-type hint: this instruction is detected as a writing task — lean the role toward a senior writer or editor for the domain, and make the output explicit about the genre, length, tone, and target reader.\nRole-writing tip: lean identity + genre — name the persona (e.g. "senior copywriter") and be explicit about genre, length and tone.\nSection emphasis: strengthen the Role and Context sections (persona, audience, tone); keep the Format section.',
  analysis: 'Task-type hint: this instruction is detected as an analysis/research task — lean the role toward an analyst or researcher, and make the output explicit about leading with conclusions, citing evidence and data sources, and listing the analysis dimensions.\nRole-writing tip: lean identity + method — name the persona (e.g. "analyst / researcher") and the analysis approach (e.g. "lead with conclusions, back them with data").\nSection emphasis: strengthen the Task and Context sections (method, data source); lead the Format section with the conclusion.',
  ops: 'Task-type hint: this instruction is detected as an execution/operations task — lean the role toward an executor or ops persona, and make the output explicit about step order, prerequisites, and completion checks.\nRole-writing tip: lean behavior + steps — state execution boundaries and step order (e.g. "verify the environment first, follow the checklist, self-check when done").\nSection emphasis: strengthen the Task and Format sections (steps, commands, rollback); keep the Role section concise.',
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
- 输出必须包含四段，标题严格使用英文：## Role、## Task、## Context、## Format。
- 全局：精炼——删除重复表述、空话与无意义假设，每条信息一句为限。
- 全局：正文按句断行——每句或每个要点独占一行，段落间空一行；避免超长单行。
- ## Role：设定与任务强相关的具体角色（「身份＋能力＋行为」三要素；不必以"你是"开头；能力或行为约束更可执行）。指令已明确执行主体则沿用，否则按任务类型与领域推断（代码→资深工程师、文案→资深撰稿人），体现所需专业度；能力陈述简短、不重复 Task；避免空泛角色。
- ## Task：用明确动词描述任务，必要时拆成可执行步骤；目标具体、可衡量；说明完成标准。
- ## Context：补充背景、约束、目标受众与质量标准；不虚构事实，不重复指令已含信息；仅信息确实缺失时声明假设；无额外背景或约束时可写"无额外背景，按通用标准执行"，不必硬凑信息。
- ## Format：规定输出结构、格式、长度与风格（四项齐全，未明确的给合理默认）；保留指令中的格式与长度要求；输出分类与 Task 维度一一对应、顺序一致。`

/** Plain-style structure paragraph (no headings, continuous prose). */
const STRUCTURE_PLAIN = `输出结构：
- 输出必须是一段完整、连贯、可直接交给 AI 执行的提示词正文。
- 正文依次覆盖：角色定位（与任务强相关、避免空泛；"身份＋能力＋行为"三要素，不必以"你是"开头）、任务与步骤（含完成标准）、背景与约束（不虚构事实，仅信息缺失时声明假设；无额外信息时一句带过）、输出格式与长度（未明确处给合理默认）。
- 正文必须精炼——删重复表述、空话与无意义假设，每条信息一句为限；输出分类与任务维度一一对应、顺序一致。
- 正文按句断行——每句或每个要点一行，段落间空一行；避免超长单行。
- 严禁使用任何小节标题（如 ##、###）或"角色：""任务："等字段标签——即使需要分点，也用普通段落或列表，绝不输出标题行。`

/** Section-mode pre-output self-check. */
const SELFCHECK_SECTIONS = `- 输出前自查：四段标题齐全且每段有实质内容；角色强相关、不空泛、含能力或行为描述；Context 无虚构；Format 覆盖结构/格式/长度/风格；无重复表述、空话与多余假设，长度尽量短；正文按句断行、无超长单行。缺一不可。`

/** Plain-mode pre-output self-check. */
const SELFCHECK_PLAIN = `- 输出前自查：正文完整覆盖上述四个方面（含完成标准、假设与格式默认），长度足以直接执行，无小节标题或字段标签；角色含能力或行为描述；无重复表述、空话与多余假设，长度尽量短；正文按句断行、无超长单行。`

/** English section-style structure paragraph (the default output shape). */
const STRUCTURE_SECTIONS_EN = `Section structure:
- The output must contain four sections, with headings strictly in English: ## Role, ## Task, ## Context, ## Format.
- Global: be concise — drop repeated statements, filler, and meaningless assumptions; keep every piece of information to one sentence.
- Global: break lines by sentence — each sentence or bullet on its own line, with a blank line between paragraphs; avoid overlong single lines.
- ## Role: set a specific role strongly tied to the task, using the "identity + capability + behavior" formula — no need to start with "you are", and a capability or behavior clause is equally valid and often more actionable. Reuse an explicit executor from the instruction when present; otherwise infer one from the task type and domain (e.g. senior engineer for coding, senior copywriter for writing), reflecting the required expertise; keep capability statements brief and free of requirements already covered in ## Task; avoid generic roles like "AI assistant".
- ## Task: describe the task with clear verbs, breaking it into executable steps when necessary; the goal must be specific and measurable; state the completion criteria.
- ## Context: add background, constraints, target audience, and quality standards; never invent facts or repeat what the instruction already states; state assumptions only when information is genuinely missing; when there is no extra background or constraints, write "no extra context — apply general standards" instead of padding.
- ## Format: specify the output structure, format, length, and style (all four, with reasonable defaults where unspecified); keep any format/length requirements from the instruction; the output categories must mirror the dimensions required in ## Task, in the same order.`

/** English plain-style structure paragraph (no headings, continuous prose). */
const STRUCTURE_PLAIN_EN = `Output structure:
- The output must be a complete, coherent prompt body ready to hand directly to an AI for execution.
- The body must cover, in order: the role (strongly tied to the task, not generic; prefer the "identity + capability + behavior" formula — "you are" is optional), the task and its steps (including completion criteria), necessary background and constraints (no invented facts; state assumptions only when information is missing; skip padding when nothing extra applies), and the output format and length (with reasonable defaults where unspecified).
- The body must be concise — drop repeated statements, filler, and meaningless assumptions; keep every piece of information to one sentence; the output categories must mirror the dimensions required by the task, in the same order.
- Break lines by sentence — each sentence or bullet on its own line, with a blank line between paragraphs; avoid overlong single lines.
- Never use any subsection headings (such as ## or ###) or field labels like "Role:" or "Task:" — even when breaking the content into points, use plain paragraphs or lists, never heading lines.`

/** English section-mode pre-output self-check. */
const SELFCHECK_SECTIONS_EN = `- Self-check before output: all four section headings exist with substantive content; the role is strongly tied to the task, not generic, and includes a capability or behavior clause; the context contains no invented facts; the format covers structure, format, length, and style; no repeated statements, filler, or meaningless assumptions, and as short as possible while meeting the requirements; lines are broken by sentence with no overlong single lines. None may be missing.`

/** English plain-mode pre-output self-check. */
const SELFCHECK_PLAIN_EN = `- Self-check before output: the body covers all four aspects above (completion criteria, assumptions, and format defaults included), is long enough to be executed directly, and contains no section headings or field labels; the role includes a capability or behavior clause; no repeated statements, filler, or meaningless assumptions, and as short as possible while meeting the requirements; lines are broken by sentence with no overlong single lines.`

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
const BUILTIN_SUBTYPE_EXAMPLES: Record<MetaLanguage, Partial<Record<TaskSubtype, PromptExample>>> = {
  zh: {
    'code-bugfix': {
      input: '定位并修复 @src/cache.ts 的报错',
      output: '## Role\n资深 TypeScript 工程师，精通类型检查与缓存模块设计，先保证可运行再优化。\n\n## Task\n对 @src/cache.ts 做完整错误诊断与最小修复：先静态检查与代码走读定位全部报错点，逐条列出错误类型与触发条件；再做最小修复，保持导出接口/函数签名/缓存语义（LRU+TTL、键值存储）完全不变，每处改动附注释说明依据；最后运行 tsc --noEmit 与相关单测，确认报错消除且无新增警告或行为变更。\n\n## Context\n@src/cache.ts 是纯函数缓存层（fnv1a 哈希 + bigramJaccard + LRU/TTL，无 harness 依赖）。未提供具体报错信息与环境——无法精确定位时采取最保守修复，并说明推断依据与可复现步骤。\n\n## Format\n依次输出三部分：①根因分析（短条目）②改动点（文件+行号+修改前后对比）③测试结果；涉及代码提供可直接运行的完整 TypeScript 片段。',
    },
    'analysis-review': {
      input: '评估 localTemplate 本地直出的覆盖面与边界',
      output: '## Role\n资深提示词插件架构师，熟悉 localTemplate 本地直出机制与 token 成本模型。\n\n## Task\n评估 1.5.6 本地直出覆盖面与边界，输出系统化结论：先梳理门控规则（子类命中 + 可抽取信号）；再对照 21 个可直出子类与 4 个永不直出（创作/演讲/研究/预测）的边界；最后评估「本地直出 + LLM 精修」混合两档的收益。\n\n## Context\n1.5.6 已实现本地直出：零 token 零延迟；本地路径不读上下文；/optimize-stats 的 LOCAL:<n> 可观测。实际直出 token 为 0，非 ≤1000。\n\n## Format\n结构化清单：①直出判定标准（确定性/无依赖/可规则化 ↔ 现有门控）②可直出 vs 必须 LLM 的边界（附实际 token）③上下文感知关闭的适用条件与风险④按优先级列出优化项（模板缺口→门控阈值→评估）。重点突出可直出与不可直出的边界。',
    },
  },
  en: {
    'code-bugfix': {
      input: 'Locate and fix the errors in @src/cache.ts',
      output: '## Role\nSenior TypeScript engineer, proficient in type checking and cache-module design; make it run first, then optimize.\n\n## Task\nDiagnose and minimally fix @src/cache.ts: statically check and walk the code to locate every error, listing each error type and trigger condition; then apply the minimal fix that keeps the exported interfaces, function signatures and cache semantics (LRU+TTL, key-value storage) unchanged, annotating the rationale for each change; finally run tsc --noEmit and the related unit tests to confirm the errors are gone with no new warnings or behavior changes.\n\n## Context\n@src/cache.ts is a pure-function cache layer (fnv1a hash + bigramJaccard + LRU/TTL, no harness dependency). No concrete error message or environment is provided — when the root cause cannot be pinpointed, apply the most conservative fix and state the inference basis and reproduction steps.\n\n## Format\nOutput three parts in order: ① root-cause analysis (short bullets) ② changes (file + line + before/after) ③ test results; include a directly runnable complete TypeScript snippet wherever code is involved.',
    },
    'analysis-review': {
      input: 'Assess the coverage and boundaries of localTemplate local rendering',
      output: '## Role\nSenior prompt-plugin architect, familiar with the localTemplate local-render mechanism and the token cost model.\n\n## Task\nAssess the coverage and boundaries of the 1.5.6 local render and produce a systematic conclusion: first walk the gate rules (subcategory match + extractable signals); then compare the 21 renderable subcategories against the 4 never-rendered ones (creative/speech/research/forecast); finally weigh the hybrid two-tier benefit of "local render + LLM refine".\n\n## Context\n1.5.6 already ships local render: zero tokens, zero latency; the local path never reads conversation context; /optimize-stats exposes LOCAL:<n>. Actual local-render tokens are 0, not ≤1000.\n\n## Format\nStructured checklist: ① render criteria (deterministic / context-free / rule-izable ↔ the existing gate) ② the renderable-vs-LLM boundary with actual tokens ③ when turning context-awareness off is appropriate and its risks ④ prioritized next steps (template gaps → gate thresholds → evaluation). Highlight the renderable / not-renderable boundary.',
    },
  },
}

/** Pick the built-in example pair for a language + task type (+ subtype). */
function resolveBuiltinExamples(
  en: boolean,
  taskType: TaskType | undefined,
  subtype: TaskSubtype | undefined,
): readonly PromptExample[] {
  const subtypeSet = en ? BUILTIN_SUBTYPE_EXAMPLES.en : BUILTIN_SUBTYPE_EXAMPLES.zh
  if (subtype !== undefined) {
    const sub = subtypeSet[subtype]
    if (sub !== undefined) return [sub]
  }
  const set = en ? BUILTIN_EXAMPLES.en : BUILTIN_EXAMPLES.zh
  const key = taskType !== undefined && taskType !== 'other' ? taskType : 'writing'
  return [set[key]]
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
  builtinExamples?: boolean,
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
  const effectiveExamples = examples !== undefined && examples.length > 0
    ? examples
    : (builtinExamples === false ? [] : resolveBuiltinExamples(en, taskType, subtype))
  const exampleBlock = outputStyle !== 'plain' && effectiveExamples.length > 0
    ? `参考以下示例的格式与风格（示例仅为示范，不要照抄内容）：\n${effectiveExamples
        .map((e, i) => `示例 ${i + 1}：\n原始指令：${e.input}\n优化结果：\n${e.output}`)
        .join('\n\n')}\n`
    : ''
  const diagnosisBlock = diagnosis !== undefined && diagnosis.trim().length > 0
    ? (en
        ? `- The previous output had the following problems; this output must fix them: ${diagnosis.trim()}\n`
        : `- 上次输出存在以下问题，本次输出必须修正：${diagnosis.trim()}\n`)
    : ''
  const taskTypeBlock = taskType !== undefined && taskType !== 'other'
    ? `${en ? TASKTYPE_EN[taskType] : TASKTYPE_ZH[taskType]}\n`
    : ''
  // `detectTaskSubtype` 仅在非 other 类型下命中，但 `taskType` 本身可能是
  // `'other'`（子类为 undefined）——子类提示只在子类命中时注入即可。
  const subtypeBlock = subtype !== undefined
    ? (en
        ? `- Subtype hint: this instruction falls into the 【${subtypeLabel(subtype, true)}】 category.\n`
        : `- 子类提示：该指令属于【${subtypeLabel(subtype, false)}】类任务。\n`)
    : ''
  // 场景骨架（1.5.1）：子类命中时注入 SUB_TOPIC_TEMPLATES，给模型一个可直接
  // 填充的 Role/Task/Format 骨架（ADR-009 内容级门控——仅命中时注入）。
  const sceneBlock = subtype !== undefined
    ? `${en ? SUB_TOPIC_TEMPLATES[subtype].en : SUB_TOPIC_TEMPLATES[subtype].zh}\n`
    : ''
  // 角色参考（1.4.9）：画像无显式角色（低置信）时给模型一个可直接采用的角色
  // 三要素参考——与任务类型提示并列注入，不进情境画像。
  const roleLibraryBlock = taskType !== undefined && taskType !== 'other'
    ? `${en ? ROLE_LIBRARY[taskType].en : ROLE_LIBRARY[taskType].zh}\n`
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
    taskType: `${taskTypeBlock}${subtypeBlock}${roleLibraryBlock}${sceneBlock}`,
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
  builtinExamples?: boolean,
): string {
  const template = metaLanguage === 'en' ? templates.optimizeEn : templates.optimizeZh
  const resolvedProfile = profile ?? buildSituationProfile(input, context)
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, context, taskType ?? resolvedProfile.task.type, maxOutputTokens, resolvedProfile, resolvedProfile.task.subtype, undefined, level, builtinExamples))
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
  builtinExamples?: boolean,
): string {
  const template = metaLanguage === 'en' ? templates.iterateEn : templates.iterateZh
  const resolvedProfile = profile ?? buildSituationProfile(instruction, context)
  const rendered = renderBlocks(template, metaBlocks(language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, context, taskType ?? resolvedProfile.task.type, maxOutputTokens, resolvedProfile, resolvedProfile.task.subtype, drift, level, builtinExamples))
  return rendered.replace(/\{\{上次结果\}\}|\{\{迭代指令\}\}/g, (match) =>
    match === '{{上次结果}}' ? lastResult : instruction,
  )
}