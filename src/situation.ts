/**
 * Situation-awareness layer: pure, harness-free extraction of a structured
 * 角色/任务/目标 (role / task / goal) profile from a raw instruction, plus a
 * goal-alignment check for the validation loop and goal-drift detection for
 * iteration.
 *
 * Everything here is a pure function over plain strings — no harness
 * dependency, no `llm`, no config. P0 delivered explicit-role extraction,
 * goal/constraint extraction, `goalAlignment`, and the `{{情境画像}}` block
 * renderer. P1 added two-level task classification (`detectTaskSubtype`),
 * measurability detection, `goalDrift`, profile memoization, and
 * conversation-role fallback via `context`. P2 adds profile schema
 * versioning (`SITUATION_PROFILE_VERSION`), the injection-budget gate
 * (`SituationProfileLevel`), and session-goal merging (`mergeGoals`, used by
 * the service's session registry). P1 (role-design 方案) extends the role
 * extraction with capability (精通/擅长/Proficient in…) and behavior
 * (先给…/拒绝…/avoid…) signals plus scene-style identities (以…的身份 /
 * acting as…) — `RoleProfile` v2. The `mainVerb` / `object` /
 * `successCriteria` fields are declared for interface stability.
 */

import { bestScoreByKeywords, detectTaskType, type TaskType } from './meta.js'

/** Perceived role of the executor derived from the instruction. */
export interface RoleProfile {
  /** Explicit role clause extracted verbatim (e.g. "你是一名资深产品经理"). */
  explicit?: string
  /** Role archetype suggested by the detected task category. */
  archetype?: TaskType
  /** Perceived expertise marker (e.g. 资深 / senior / 10 年经验). */
  expertise?: string
  /** Capability clause extracted verbatim (精通/擅长/Proficient in…, P1). */
  capability?: string
  /** Behavior rule clause extracted verbatim (先给…/拒绝…/avoid…, P1). */
  behavior?: string
  /** Perceived target audience (e.g. 产品经理 / C-level). */
  audience?: string
  /** Perceived tone (e.g. 正式 / 口语化). */
  tone?: string
  /**
   * Confidence score 0–8: 2 for an explicit role clause, 2 each for
   * capability and behavior clauses, 1 each for archetype (non-`other`),
   * expertise, audience and tone signals. Content-level signals
   * (capability / behavior) outweigh soft ones so a bare capability clause
   * can pass the injection gate on its own (P1).
   */
  confidence: number
}

/** Perceived task shape. P0 fills only `type`; the rest arrive in P1. */
export interface TaskProfile {
  /** Coarse task category (see `detectTaskType`). */
  type: TaskType
  /** Two-level subcategory (globally unique key, see `detectTaskSubtype`). */
  subtype?: TaskSubtype
  /** Main action verb (P1). */
  mainVerb?: string
  /** Action object (P1). */
  object?: string
  /** Whether the instruction carries measurable signals (deadline/quantity). */
  measurable?: boolean
}

/** Perceived goal: what the user wants, and what must not be violated. */
export interface GoalProfile {
  /** Explicit goal sentence (目标是/目的是/希望…). */
  primary?: string
  /** Constraint clauses (必须/不要/不超过/至少…). */
  constraints: string[]
  /** Measurable acceptance criteria (P1). */
  successCriteria: string[]
}

/** The combined situation profile. */
export interface SituationProfile {
  /** Schema version (see `SITUATION_PROFILE_VERSION`); consumers can react to shape changes. */
  version: number
  role: RoleProfile
  task: TaskProfile
  goal: GoalProfile
}

/** Current `SituationProfile` schema version (P2: 画像版本化对外公开; P1: v2 增 capability/behavior). */
export const SITUATION_PROFILE_VERSION = 2

/** How much of the situation profile the role document injects (P2 config). */
export type SituationProfileLevel = 'off' | 'minimal' | 'full'

/**
 * Merge a previously registered session goal into the current instruction's
 * goal (P2 会话级目标注册表). Fallback semantics — the current instruction
 * wins whenever it states something: its primary replaces the registry's,
 * and a non-empty constraint list replaces the registry's. This keeps goals
 * alive across turns without resurrecting constraints the user has moved on
 * from. Pure function.
 */
export function mergeGoals(registry: GoalProfile, current: GoalProfile): GoalProfile {
  return {
    primary: current.primary ?? registry.primary,
    constraints: current.constraints.length > 0 ? current.constraints : registry.constraints,
    successCriteria: current.successCriteria.length > 0 ? current.successCriteria : registry.successCriteria,
  }
}

/** Explicit-role markers, Chinese. */
const ZH_ROLE_MARKERS = ['你是一名', '你是一位', '你是', '你负责', '你担任', '作为一位', '作为一个', '扮演'] as const

/** Explicit-role markers, English (bare "as a/an" is too noisy to use). */
const EN_ROLE_MARKERS = ['you are', "you're", 'act as'] as const

/**
 * Capability markers (P1): 能力句（精通/擅长/熟悉…）→ 保留整句作为能力信号。
 * 匹配即强信号——让"纯能力句"（无"你是"身份）也能被识别为角色。
 */
const ZH_CAPABILITY = /(?:精通|擅长|熟悉|熟练|掌握|善于|深谙|能熟练)[^，。；;,\n]{1,24}/g
const EN_CAPABILITY = /\b(?:proficient in|expert in|skilled at|skilled in|good at|experienced with|familiar with|speciali[sz]ed in)\s+[^.,;\n]{1,30}/gi

/**
 * Behavior markers (P1): 行为规则句（先给/总是/拒绝/避免…）。刻意避开
 * "必须/不要/不超过"等目标约束标记——那些属于 `GoalProfile.constraints`；
 * 角色行为与目标约束分离，避免同一句被双重注入。
 */
const ZH_BEHAVIOR = /(?:先给出|先确认|先说明|先明确|先列出|先给|总是|始终|一律|尽量|避免|拒绝|宁可|宁愿|刻意|主动)[^，。；;,\n]{1,24}/g
const EN_BEHAVIOR = /\b(?:always|never|avoid|refuse|lead with|start with|be concise|be direct|state (?:the )?assumptions|never guess)[^.,;\n]{0,40}/gi

/** Scene markers (P1): "以…的身份/角色" 类场景式身份，并入 `explicit` 抽取。 */
const ZH_SCENE = /(?:以|作为)[^，。；;,\n]{1,16}(?:的身份|的角色|身份)/g
const EN_SCENE = /(?:acting as|in the role of)\s+[^.,;\n]{1,30}/gi

/** Expertise markers → the marker itself is kept as the signal. */
const EXPERTISE_MARKERS = ['资深', '高级', '首席', '专家', 'senior', 'expert', 'lead'] as const

/** Audience markers. */
const ZH_AUDIENCE = /面向([^，。；;,\n]{1,20})|针对([^，。；;,\n]{1,20})|写给([^，。；;,\n]{1,20})|向([^，。；;,\n]{1,12})汇报/g
// Bare `for` is too noisy ("for example", "script for parsing CSV") to use as
// an audience signal; only explicit targeting phrases qualify.
const EN_AUDIENCE = /\btarget(?:ing)?\s+([^.,;]{1,24})/gi

/** Tone markers. */
const TONE_MARKERS = ['正式', '口语', '轻松', '幽默', '严谨', '简洁', '详尽', 'formal', 'casual', 'friendly', 'concise', 'detailed'] as const

/** Goal-sentence markers (Chinese) — stops at the first constraint marker. */
const ZH_GOAL = /(?:目标是|目的是|目标为|希望|旨在|让[^，。；;,\n]{1,20}(?:能够|可以))[^。，；;不要不能必须不得只能不允许禁止务必请勿不超过至少\n]{1,60}/g

/** Goal-sentence markers (English) — runs to the end of the sentence. */
const EN_GOAL = /(?:the\s+goal\s+is|goal\s*:|aim\s+to|i\s+want\s+to)[^.\n]{1,80}/gi

/** Constraint markers (Chinese) — the clause up to the next delimiter. */
const ZH_CONSTRAINT = /(?:必须|不要|不能|不得|只能|不允许|禁止|务必|请勿|不超过|至少|不得少于)[^。，；;,\n]{1,60}/g

/** Constraint markers (English) — the clause up to the next delimiter. */
const EN_CONSTRAINT = /(?:must\s+not|mustn't|must|cannot|can't|should\s+not|no\s+more\s+than|no\s+fewer\s+than|at\s+most|at\s+least|within)[^.;,\n]{1,60}/gi

/** Clauses that are punctuation/particle delimiters for anchor extraction. */
const PARTICLE_SPLIT = /(?:一份|一个|一种|一下|一点|将|把|要|以及|并且)/g

/** Leading modal/constraint verbs stripped from an anchor token. */
const LEAD_STRIP = /^(?:必须|不要|不能|只能|不得|不允许|禁止|务必|请勿|需要|请|不超过|不得少于|不少于|至少|超过|少于|多于|目标是|目的是|目标为|旨在|希望|让)/

/** Function words dropped when deriving alignment anchors. */
const STOPWORDS = new Set([
  '必须', '不要', '不能', '只能', '不得', '不允许', '禁止', '请', '需要', '要',
  '的', '了', '在', '与', '和', '以及', '或', '不', '都', '会', '可以', '应该',
  '把', '被', '为', '向', '给', '让', '是', '有', '做', '请务必',
])

/** Role archetype label per task category (used by the block renderer). */
export function archetypeLabel(type: TaskType, en: boolean): string | undefined {
  switch (type) {
    case 'code':
      return en ? 'senior engineer / architect' : '资深工程师/架构师'
    case 'writing':
      return en ? 'senior writer / editor' : '资深撰稿人/编辑'
    case 'analysis':
      return en ? 'analyst / researcher' : '分析师/研究员'
    case 'ops':
      return en ? 'executor / ops role' : '执行者/运维角色'
    default:
      return undefined
  }
}

/** Two-level subcategory keys (globally unique, prefixed by task category). */
export type TaskSubtype =
  | 'code-bugfix' | 'code-feature' | 'code-refactor' | 'code-review' | 'code-script'
  | 'writing-report' | 'writing-email' | 'writing-copy' | 'writing-translate' | 'writing-creative'
  | 'analysis-data' | 'analysis-research' | 'analysis-review' | 'analysis-forecast'
  | 'ops-deploy' | 'ops-install' | 'ops-troubleshoot' | 'ops-maintain'

/** Subtype definitions: zh/en labels + matching keywords per category. */
const TASK_SUBTYPES: Record<Exclude<TaskType, 'other'>, readonly { key: TaskSubtype; zh: string; en: string; keywords: readonly string[] }[]> = {
  code: [
    { key: 'code-bugfix', zh: 'bug 修复', en: 'bug fix', keywords: ['bug', '修复', '报错', '错误', '异常', '崩溃', '不工作', '问题'] },
    { key: 'code-feature', zh: '新功能开发', en: 'feature development', keywords: ['新功能', '功能', '实现', '新增', '做一个', '添加'] },
    { key: 'code-refactor', zh: '重构', en: 'refactoring', keywords: ['重构', '优化', '简化', '清理', '重写', 'refactor'] },
    { key: 'code-review', zh: '代码审查', en: 'code review', keywords: ['审查', 'review', '走查', '检查代码'] },
    { key: 'code-script', zh: '脚本/工具', en: 'script/tool', keywords: ['脚本', '工具', '自动化', '批处理', 'script'] },
  ],
  writing: [
    { key: 'writing-report', zh: '报告/总结', en: 'report/summary', keywords: ['周报', '日报', '报告', '总结', '复盘', '汇报', '简报', 'report'] },
    { key: 'writing-email', zh: '邮件', en: 'email', keywords: ['邮件', 'email', '写信', '回信'] },
    { key: 'writing-copy', zh: '文案/营销', en: 'copywriting', keywords: ['文案', '营销', '广告', '宣传', '口号', 'slogan', '推广', '公众号', '标题'] },
    { key: 'writing-translate', zh: '翻译', en: 'translation', keywords: ['翻译', '译成', 'translate'] },
    { key: 'writing-creative', zh: '创作', en: 'creative writing', keywords: ['故事', '小说', '诗', '剧本', '散文'] },
  ],
  analysis: [
    { key: 'analysis-data', zh: '数据分析', en: 'data analysis', keywords: ['数据', '统计', '指标', '趋势', '图表', '报表'] },
    { key: 'analysis-research', zh: '研究/调研', en: 'research', keywords: ['研究', '调研', '资料', '文献', '调查'] },
    { key: 'analysis-review', zh: '评估/审查', en: 'evaluation/review', keywords: ['评估', '对比', '比较', '审查', '复盘', '评价'] },
    { key: 'analysis-forecast', zh: '预测', en: 'forecasting', keywords: ['预测', '预估', '走势', '前景'] },
  ],
  ops: [
    { key: 'ops-deploy', zh: '部署/发布', en: 'deploy/release', keywords: ['部署', '发布', '上线', 'deploy', 'release'] },
    { key: 'ops-install', zh: '安装/配置', en: 'install/configure', keywords: ['安装', '配置', '设置', 'install', 'configure'] },
    { key: 'ops-troubleshoot', zh: '排查/修复', en: 'troubleshooting', keywords: ['排查', '定位', '诊断', '解决', 'troubleshoot'] },
    { key: 'ops-maintain', zh: '运维/监控', en: 'ops/monitoring', keywords: ['运维', '监控', '备份', '恢复', '迁移', '清理'] },
  ],
}

/** Detect the two-level subcategory of an instruction (given its coarse type). */
export function detectTaskSubtype(input: string, type: TaskType): TaskSubtype | undefined {
  if (type === 'other') return undefined
  const { item, score } = bestScoreByKeywords(TASK_SUBTYPES[type], input.toLowerCase())
  return score > 0 ? item?.key : undefined
}

/** Human label for a subcategory key. */
export function subtypeLabel(key: TaskSubtype, en: boolean): string {
  for (const defs of Object.values(TASK_SUBTYPES)) {
    const def = defs.find((d) => d.key === key)
    if (def !== undefined) return en ? def.en : def.zh
  }
  return key
}

/** Measurable-signal markers: quantities with units, range verbs, deadlines. */
const MEASURABLE_RE = /(?:\d+(?:\.\d+)?\s*(?:个|条|页|字|份|次|秒|分钟|小时|天|周|月|年|%|人|篇|words?|pages?|items?|minutes?|hours?|days?|percent))|(?:至少|不超过|不少于|多于|少于|最多|截止|今天|明天|本周|下周|月底)|\b(?:within|at\s+least|at\s+most|no\s+more\s+than|no\s+fewer\s+than|deadline)\b/i

/** Whether the instruction carries measurable signals (quantity/deadline). */
export function detectMeasurable(input: string): boolean {
  return MEASURABLE_RE.test(input)
}

/** The four goal-drift states between two iterations. */
export type GoalDrift = 'unchanged' | 'added' | 'modified' | 'dropped'

/** All alignment anchors of a goal profile (primary + every constraint). */
function goalAnchorsOf(goal: GoalProfile): string[] {
  const all: string[] = []
  if (goal.primary !== undefined) all.push(...goalAnchors(goal.primary))
  for (const c of goal.constraints) all.push(...goalAnchors(c))
  return all
}

/**
 * Compare the goal of the previous round with the new instruction's goal:
 * `'dropped'` when previous anchors were lost, `'added'` when the new
 * instruction introduces anchors the previous round lacked, `'modified'`
 * when the primary text changed without an anchor shift, `'unchanged'`
 * otherwise (including both being empty). Pure function.
 */
export function goalDrift(prev: GoalProfile, next: GoalProfile): GoalDrift {
  const prevAnchors = new Set(goalAnchorsOf(prev))
  const nextAnchors = new Set(goalAnchorsOf(next))
  if ([...prevAnchors].some((a) => !nextAnchors.has(a))) return 'dropped'
  if ([...nextAnchors].some((a) => !prevAnchors.has(a))) return 'added'
  if (prev.primary !== next.primary) return 'modified'
  return 'unchanged'
}

/** Short drift line appended to the situation block (zh/en). */
function driftLine(drift: GoalDrift, en: boolean): string {
  switch (drift) {
    case 'added':
      return en
        ? 'Change vs the previous result: the new instruction ADDS goal/constraint requirements — cover them.'
        : '相对上次结果：新指令新增了目标/约束要求——请覆盖它们。'
    case 'modified':
      return en
        ? 'Change vs the previous result: the new instruction MODIFIES the goal — follow the new instruction.'
        : '相对上次结果：新指令修改了目标——以新指令为准。'
    case 'dropped':
      return en
        ? 'Change vs the previous result: the new instruction DROPS some goal/constraint — do not keep the old ones.'
        : '相对上次结果：新指令移除了部分目标/约束——不要沿用旧约束。'
    default:
      return ''
  }
}

/**
 * Small in-process memo for `buildSituationProfile` (P1 画像缓存): keyed by
 * input + context, capped at 128 entries with FIFO eviction. Pure inputs, so
 * the cache never changes observable behavior — identical instructions (e.g.
 * the builder's injection and the pipeline's alignment check) share one
 * profile instead of recomputing it.
 */
const PROFILE_CACHE = new Map<string, SituationProfile>()
const PROFILE_CACHE_MAX = 128

function cacheProfile(key: string, profile: SituationProfile): SituationProfile {
  PROFILE_CACHE.set(key, profile)
  if (PROFILE_CACHE.size > PROFILE_CACHE_MAX) {
    const oldest = PROFILE_CACHE.keys().next().value
    if (oldest !== undefined) PROFILE_CACHE.delete(oldest)
  }
  return profile
}

/** Extract an explicit role clause, or `undefined`. */
function extractExplicitRole(input: string): string | undefined {
  const lower = input.toLowerCase()
  for (const marker of ZH_ROLE_MARKERS) {
    const at = input.indexOf(marker)
    if (at === -1) continue
    const rest = input.slice(at + marker.length)
    const end = rest.search(/[，。；;,\n]/)
    const clause = (end === -1 ? rest : rest.slice(0, end)).trim()
    if (clause.length >= 2 && clause.length <= 24) return `${marker}${clause}`
  }
  for (const marker of EN_ROLE_MARKERS) {
    const at = lower.indexOf(marker)
    if (at === -1) continue
    const rest = input.slice(at + marker.length)
    const end = rest.search(/[.,;\n]/)
    const clause = (end === -1 ? rest : rest.slice(0, end)).trim()
    if (clause.length >= 2 && clause.length <= 60) return `${marker}${clause}`
  }
  // Scene-style identities (P1): "以产品经理的身份…" / "Acting as a senior reviewer…".
  const zhScene = input.match(ZH_SCENE)
  if (zhScene !== null) return zhScene[0].trim()
  const enScene = input.match(EN_SCENE)
  if (enScene !== null) return enScene[0].trim()
  return undefined
}

/** Extract the first capability clause (精通/擅长/Proficient in…), or `undefined`. */
function extractCapability(input: string): string | undefined {
  const zh = input.match(ZH_CAPABILITY)
  if (zh !== null) return zh[0].trim()
  const en = input.match(EN_CAPABILITY)
  return en !== null ? en[0].trim() : undefined
}

/** Extract the first behavior rule clause (先给…/拒绝…/avoid…), or `undefined`. */
function extractBehavior(input: string): string | undefined {
  const zh = input.match(ZH_BEHAVIOR)
  if (zh !== null) return zh[0].trim()
  const en = input.match(EN_BEHAVIOR)
  return en !== null ? en[0].trim() : undefined
}

/** Extract the first expertise marker, or `undefined`. */
function extractExpertise(input: string): string | undefined {
  const lower = input.toLowerCase()
  const year = lower.match(/(\d+)\s*(?:年|years?)/)
  if (year !== null) return year[0]
  for (const marker of EXPERTISE_MARKERS) {
    if (lower.includes(marker)) return marker
  }
  return undefined
}

/** Extract an audience phrase, or `undefined`. */
function extractAudience(input: string): string | undefined {
  for (const match of input.matchAll(ZH_AUDIENCE)) {
    const phrase = match.slice(1).find((g) => g !== undefined && g.length > 0)
    if (phrase !== undefined) return phrase
  }
  for (const match of input.matchAll(EN_AUDIENCE)) {
    const phrase = match.slice(1).find((g) => g !== undefined && g.length > 0)
    if (phrase !== undefined) return phrase.trim()
  }
  return undefined
}

/** Extract a tone marker, or `undefined`. */
function extractTone(input: string): string | undefined {
  const lower = input.toLowerCase()
  for (const marker of TONE_MARKERS) {
    if (lower.includes(marker)) return marker
  }
  return undefined
}

/** Build the perceived role profile (P0: explicit + archetype + soft signals; P1: capability/behavior). */
function buildRoleProfile(input: string, taskType: TaskType): RoleProfile {
  const explicit = extractExplicitRole(input)
  const archetype = taskType === 'other' ? undefined : taskType
  const expertise = extractExpertise(input)
  const capability = extractCapability(input)
  const behavior = extractBehavior(input)
  const audience = extractAudience(input)
  const tone = extractTone(input)
  let confidence = explicit !== undefined ? 2 : 0
  if (archetype !== undefined) confidence += 1
  if (expertise !== undefined) confidence += 1
  // 能力/行为是内容级信号：各计 2 分，纯能力句即可单独通过注入门槛（P1）。
  if (capability !== undefined) confidence += 2
  if (behavior !== undefined) confidence += 2
  if (audience !== undefined) confidence += 1
  if (tone !== undefined) confidence += 1
  const profile: RoleProfile = { confidence }
  if (explicit !== undefined) profile.explicit = explicit
  if (archetype !== undefined) profile.archetype = archetype
  if (expertise !== undefined) profile.expertise = expertise
  if (capability !== undefined) profile.capability = capability
  if (behavior !== undefined) profile.behavior = behavior
  if (audience !== undefined) profile.audience = audience
  if (tone !== undefined) profile.tone = tone
  return profile
}

/** Extract the goal sentence and constraint clauses. */
function buildGoalProfile(input: string): GoalProfile {
  const zhPrimary = input.match(ZH_GOAL)
  const enPrimary = input.match(EN_GOAL)
  const primary = (zhPrimary?.[0] ?? enPrimary?.[0] ?? undefined)?.trim()
  const constraints = Array.from(input.matchAll(ZH_CONSTRAINT))
    .concat(Array.from(input.matchAll(EN_CONSTRAINT)))
    .map((m) => m[0].trim())
    .filter((text, i, arr) => arr.indexOf(text) === i)
  return { primary, constraints, successCriteria: [] }
}

/**
 * Build the situation profile for an instruction. Pure and deterministic,
 * memoized per (input, context) pair. P1: when the instruction carries no
 * explicit role clause, a role clause found in `context` is used as a
 * fallback (conversation role cues, e.g. "你是我的翻译" from an earlier turn).
 */
export function buildSituationProfile(input: string, context?: string): SituationProfile {
  const cacheKey = context === undefined ? input : `${input}\u0000${context}`
  const hit = PROFILE_CACHE.get(cacheKey)
  if (hit !== undefined) return hit
  const taskType = detectTaskType(input)
  const role = buildRoleProfile(input, taskType)
  if (role.explicit === undefined && context !== undefined && context.trim().length > 0) {
    const ctxExplicit = extractExplicitRole(context)
    if (ctxExplicit !== undefined) {
      role.explicit = ctxExplicit
      role.confidence += 2
    }
  }
  const subtype = detectTaskSubtype(input, taskType)
  const task: TaskProfile = { type: taskType }
  if (subtype !== undefined) task.subtype = subtype
  if (detectMeasurable(input)) task.measurable = true
  return cacheProfile(cacheKey, { version: SITUATION_PROFILE_VERSION, role, task, goal: buildGoalProfile(input) })
}

/**
 * Derive the alignment anchors of one piece of goal text: digit runs plus
 * meaningful tokens (particles split off, stopwords dropped, short tokens
 * rejected). `goalAlignment` is lenient — an anchor set matches when ANY
 * anchor appears in the output.
 */
export function goalAnchors(text: string): string[] {
  const anchors = new Set<string>()
  for (const chunk of text.split(/[，。；、,.;:：！？!?\s]+/)) {
    for (const token of chunk.split(PARTICLE_SPLIT)) {
      const t = token.trim()
      if (t.length === 0) continue
      for (const digits of t.match(/\d+\.?\d*/g) ?? []) anchors.add(digits)
      if (STOPWORDS.has(t)) continue
      if (t.length >= (isCJK(t) ? 2 : 3)) anchors.add(t)
      // Also anchor the token with its leading modal/constraint verb stripped,
      // so "必须包含四个段落" can match "输出包含四个段落".
      const stripped = t.replace(LEAD_STRIP, '')
      if (stripped.length >= (isCJK(stripped) ? 2 : 3)) anchors.add(stripped)
    }
  }
  return [...anchors]
}

function isCJK(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

/**
 * Check whether the optimized output kept the goal and its constraints.
 * Returns the failed goal/constraint labels; `aligned` is false when the
 * primary goal has anchors and none survive, or when any constraint lost
 * every anchor. Lenient by design (any-anchor matching) so it only flags
 * clear drops — the retry gate is intentionally loose in P0.
 */
export function goalAlignment(
  goal: GoalProfile,
  output: string,
): { missing: string[]; aligned: boolean } {
  const missing: string[] = []
  if (goal.primary !== undefined) {
    const anchors = goalAnchors(goal.primary)
    if (anchors.length > 0 && !anchors.some((a) => output.includes(a))) {
      missing.push(`目标：${goal.primary}`)
    }
  }
  for (const constraint of goal.constraints) {
    const anchors = goalAnchors(constraint)
    if (anchors.length > 0 && !anchors.some((a) => output.includes(a))) {
      missing.push(`约束：${constraint}`)
    }
  }
  return { missing, aligned: missing.length === 0 }
}

/**
 * Render the `{{情境画像}}` block for the role document (zh/en). Role
 * signals are only injected above a confidence gate (≥2 — an explicit role
 * clause or two soft signals) to avoid noisy hints from generic inputs; the
 * goal part injects whenever a goal or constraint was found; an optional
 * `drift` line is appended for iteration prompts. The `level` gate (P2,
 * `situationProfileLevel`) controls the injection budget: `'off'` renders
 * nothing, `'minimal'` skips the role signals (goal/constraints/drift only),
 * `'full'` (default) renders everything. Returns `''` when there is nothing
 * to say — the placeholder then renders away.
 */
export function renderSituationBlock(
  profile: SituationProfile,
  en: boolean,
  drift?: GoalDrift,
  level: SituationProfileLevel = 'full',
): string {
  if (level === 'off') return ''
  const parts: string[] = []
  const role = profile.role
  if (level !== 'minimal' && role.confidence >= 2) {
    const bits: string[] = []
    const label = role.explicit ?? (role.archetype !== undefined ? archetypeLabel(role.archetype, en) : undefined)
    if (label !== undefined) bits.push(label)
    if (role.expertise !== undefined) bits.push(role.expertise)
    if (role.capability !== undefined) bits.push(`${en ? 'capability: ' : '能力：'}${role.capability}`)
    if (role.behavior !== undefined) bits.push(`${en ? 'behavior: ' : '行为：'}${role.behavior}`)
    if (role.audience !== undefined) bits.push(`${en ? 'audience: ' : '受众：'}${role.audience}`)
    if (role.tone !== undefined) bits.push(`${en ? 'tone: ' : '语气：'}${role.tone}`)
    if (bits.length > 0) parts.push(en ? `Role: ${bits.join('; ')}` : `角色：${bits.join('；')}`)
  }
  const goal = profile.goal
  if (goal.primary !== undefined) parts.push(en ? `Goal: ${goal.primary}` : `目标：${goal.primary}`)
  if (goal.constraints.length > 0) {
    parts.push(en ? `Constraints: ${goal.constraints.join('; ')}` : `约束：${goal.constraints.join('；')}`)
  }
  if (drift !== undefined && drift !== 'unchanged') parts.push(driftLine(drift, en))
  if (parts.length === 0) return ''
  return en
    ? `Situation profile (reference only — the output must keep the goal and constraints intact):\n- ${parts.join('\n- ')}\n`
    : `情境画像（仅供参考——输出必须保留目标与约束）：\n- ${parts.join('\n- ')}\n`
}
