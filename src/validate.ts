/** The four required section headings, in canonical order. */
export const REQUIRED_SECTIONS = ['Role', 'Task', 'Context', 'Format'] as const

/** Maximum temperature value from OpenAI API constraints. */
export const MAX_TEMPERATURE = 2.0

/**
 * Cache for compiled section patterns to avoid repeated RegExp creation.
 * Performance optimization: pre-compile and reuse regex patterns.
 */
const SECTION_PATTERN_CACHE = new Map<string, RegExp>()

/**
 * Get a cached or newly compiled RegExp for a section heading.
 * @param section - The section name (e.g., 'Role')
 * @param allowColon - Whether to allow colon variations (: or ：)
 * @returns Compiled RegExp with 'm' (multiline) flag
 */
function getSectionPattern(section: string, allowColon: boolean = true): RegExp {
  const cacheKey = `${section}:${allowColon}`
  if (!SECTION_PATTERN_CACHE.has(cacheKey)) {
    const patternStr = allowColon
      ? `^##\\s*${section}(?:\\s*[:：])?[^\\n]*(?:\\n|$)`
      : `^##\\s*${section}(?:\\s*[:：]|\\s*$)`
    SECTION_PATTERN_CACHE.set(cacheKey, new RegExp(patternStr, 'm'))
  }
  return SECTION_PATTERN_CACHE.get(cacheKey)!
}

/**
 * Headings a section may legitimately appear under — the canonical English
 * name plus common Chinese variants. Used by `hasOptimizedSections` to
 * recognize an already-optimized prompt regardless of heading language.
 */
const SECTION_ALIASES: Record<string, readonly string[]> = {
  Role: ['Role', '角色'],
  Task: ['Task', '任务'],
  Context: ['Context', '背景', '上下文', '语境'],
  Format: ['Format', '输出', '格式', '输出格式'],
}

/** Whether every required section heading appears in `text`. */
export function hasAllSections(text: string): boolean {
  return REQUIRED_SECTIONS.every((section) =>
    getSectionPattern(section, false).test(text),
  )
}

/**
 * Whether `text` already looks like an optimized prompt: all four required
 * sections present under their canonical English heading OR a Chinese-variant
 * heading (`## 角色` / `## 任务` / `## 背景` / `## 输出` etc.), or the
 * Role/Task/Goal labeled form (1.6.5). Used by the
 * `skipIfAlreadyOptimized` pass-through so a re-optimization of an
 * already-structured prompt (in either language) is skipped.
 */
export function hasOptimizedSections(text: string): boolean {
  if (hasRoleTaskGoalLabels(text)) return true
  return REQUIRED_SECTIONS.every((section) =>
    SECTION_ALIASES[section].some((alias) =>
      // C-6 修复：复用 getSectionPattern 缓存（原为每次 new RegExp）。
      getSectionPattern(alias, false).test(text),
    ),
  )
}

/** Whether any of the four section headings appears in `text`. */
export function hasSectionHeadings(text: string): boolean {
  return REQUIRED_SECTIONS.some((section) =>
    getSectionPattern(section, false).test(text),
  )
}

/**
 * The body text of one section (everything between its heading and the next
 * heading or end), trimmed.
 */
export function sectionBody(text: string, section: string): string {
  const pattern = getSectionPattern(section, true)
  const match = pattern.exec(text)
  if (match === null) return ''
  const from = match.index + match[0].length
  // The next heading starts the next section.
  const next = text.slice(from).search(/^##\s/m)
  const body = next === -1 ? text.slice(from) : text.slice(from, from + next)
  return body.trim()
}

/**
 * Whether every required section is present AND its body contains at least
 * `minChars` non-whitespace characters. `minChars <= 0` falls back to the
 * heading-only check.
 */
export function hasValidSections(text: string, minChars: number): boolean {
  if (minChars <= 0) return hasAllSections(text)
  return REQUIRED_SECTIONS.every((section) => {
    const body = sectionBody(text, section)
    return body.replace(/\s/g, '').length >= minChars
  })
}

/**
 * Whether the whole text contains at least `minChars` non-whitespace
 * characters (the plain-style content floor).
 */
export function hasSubstantialContent(text: string, minChars: number): boolean {
  return text.replace(/\s/g, '').length >= minChars
}

/**
 * Whether a plain-style output is acceptable: at least `minChars`
 * non-whitespace characters AND no four-section headings (the plain style
 * forbids headings; this is the enforcement backstop for the meta-prompt rule).
 */
export function hasPlainOutput(text: string, minChars: number): boolean {
  return hasSubstantialContent(text, minChars) && !hasSectionHeadings(text)
}

/** Stable failure message when a plain-style prompt is empty or too short. */
export function thinOutputMessage(minChars: number): string {
  return `optimized prompt has fewer than ${minChars} meaningful characters`
}

/** Stable failure message when a plain-style output carries section headings. */
export function plainHeadingsMessage(): string {
  return 'optimized prompt contains section headings (## Role / ## Task / ## Context / ## Format) in plain style'
}

/**
 * Purity gate (1.6.3, P0): whether the output carries meta/methodology
 * content instead of only the optimized prompt itself. Catches the model
 * appending things like "优化标准" sections, a "Role 定谁来说" summary, or a
 * "总结：" afterword. Detection is deliberately conservative — heading-level
 * and strong-marker patterns only, so a legit prompt that merely *mentions*
 * one of these words is not flagged.
 *
 * Fix (#2): Only scan the last 300 characters to avoid false positives
 * on legitimate prompt content that mentions these words in the body.
 * Meta content typically appears at the end (afterword, summary, etc.).
 */
const META_CONTENT_PATTERNS: RegExp[] = [
  // 章节级方法论标题：如「Role（角色设定）优化标准」「Task（任务描述）优化标准」
  /^[A-Za-z\u4e00-\u9fff]+（[^）]*）[^\n]{0,12}(优化标准|要点|原则|解析)/m,
  // 强方法论词（正常成品提示词极少出现）
  /优化标准|核心约束逻辑|方法论/g,
  // 行首总结 / 归纳 / 综上（元归纳章节）
  /^(总结|小结|归纳|综上|总而言之)[:：]/m,
  // 四段定位口诀：「Role 定"谁来说"」「Task 定"说什么"」等
  /定["“'](谁来说|说什么|基于什么说|怎么说|说给谁听)/,
]

/**
 * Maximum characters to scan from the end of the output for meta content.
 * Meta content (afterwords, summaries, methodology notes) typically appears
 * at the end of the output, not in the middle of the prompt body.
 */
const META_CONTENT_SCAN_TAIL = 300

/**
 * Whether `text` contains meta/methodology content beyond the prompt itself.
 *
 * Fix (#2): Only scans the last META_CONTENT_SCAN_TAIL characters to avoid
 * false positives. For example, a prompt that says "分析方法：结论先行、
 * 数据支撑" in the Context section should NOT be flagged as meta content —
 * only appendices like "优化标准：..." or "总结：..." at the end are flagged.
 */
export function hasMetaContent(text: string): boolean {
  // Scan only the tail to avoid false positives on body content.
  const tail = text.length > META_CONTENT_SCAN_TAIL
    ? text.slice(-META_CONTENT_SCAN_TAIL)
    : text
  return META_CONTENT_PATTERNS.some((pattern) => pattern.test(tail))
}

/** Stable failure message when the output carries meta/methodology content. */
export function metaContentMessage(): string {
  return 'optimized prompt contains meta/methodology content (e.g. "优化标准", "核心约束逻辑", a "总结：" afterword) — only the prompt itself is allowed'
}

/**
 * Role/Task/Goal labels (1.6.5): the parseable three-element output form.
 * zh: 角色：/任务：/目标：；en: Role:/Task:/Goal:. Either language set is
 * accepted by the validators, so downstream parsing works regardless of the
 * role-document language.
 */
export const RTG_LABELS_ZH = ['角色', '任务', '目标'] as const
export const RTG_LABELS_EN = ['Role', 'Task', 'Goal'] as const

const RTG_LABEL_RE = (label: string): RegExp =>
  new RegExp(`^${label}[:：]`, 'm')

/** Whether all three Role/Task/Goal labels appear in `text` (zh or en set). */
export function hasRoleTaskGoalLabels(text: string): boolean {
  const zh = RTG_LABELS_ZH.every((label) => RTG_LABEL_RE(label).test(text))
  const en = RTG_LABELS_EN.every((label) => RTG_LABEL_RE(label).test(text))
  return zh || en
}

/**
 * Whether `text` is a valid Role/Task/Goal output: all three labels present
 * AND every labeled part carries at least `minChars` non-whitespace
 * characters. `minChars <= 0` falls back to the label-only check.
 * Fix (P1a): the "next label" scan only matches real RTG labels — the old
 * `/^[^\n]{0,8}[:：]/` wrongly treated content lines like "分析销售数据趋势："
 * as labels, truncating the body to < minChars.
 */
export function hasValidRoleTaskGoal(text: string, minChars: number): boolean {
  if (!hasRoleTaskGoalLabels(text)) return false
  if (minChars <= 0) return true
  const zh = RTG_LABELS_ZH.every((label) => RTG_LABEL_RE(label).test(text))
  const labels = zh ? RTG_LABELS_ZH : RTG_LABELS_EN
  const nextLabelRe = new RegExp(
    `^(?:${[...RTG_LABELS_ZH, ...RTG_LABELS_EN].join('|')})[:：]`,
    'm',
  )
  return labels.every((label) => {
    const match = RTG_LABEL_RE(label).exec(text)
    if (match === null) return false
    const from = match.index + match[0].length
    const next = text.slice(from).search(nextLabelRe)
    const body = next === -1 ? text.slice(from) : text.slice(from, from + next)
    return body.replace(/\s/g, '').length >= minChars
  })
}

/** Body text of one `## <section>` block in a four-section render. */
function sectionBodyOf(text: string, section: string): string {
  const pattern = new RegExp(`^##\\s*${section}[\\s\\S]*?$`, 'm')
  const heading = pattern.exec(text)
  if (heading === null) return ''
  const from = heading.index + heading[0].length
  const next = text.slice(from).search(/^##\s/m)
  const body = next === -1 ? text.slice(from) : text.slice(from, from + next)
  return body.replace(/\n+/g, '\n').trim()
}

/**
 * Fold a four-section render into the Role/Task/Goal form (1.6.5):
 * 角色 ← Role, 任务 ← Task, 目标 ← Context + Format merged on one line.
 * Labels follow the render language (zh 角色：/任务：/目标：, en Role:/Task:/Goal:).
 * Lives in validate.ts so both local.ts (local fold) and meta.ts (RTG example
 * folding) can use it without a local↔meta cycle. Pure function.
 */
export function toRoleTaskGoal(fourSections: string, en: boolean): string {
  const role = sectionBodyOf(fourSections, 'Role')
  const task = sectionBodyOf(fourSections, 'Task')
  const context = sectionBodyOf(fourSections, 'Context')
  const format = sectionBodyOf(fourSections, 'Format')
  const goalParts = [context, format].filter((p) => p.length > 0)
  const goal = goalParts.join(en ? ' ' : '；')
  const label = (zh: string, enLabel: string, body: string): string =>
    `${en ? `${enLabel}:` : `${zh}：`}\n${body}`
  return [
    label('角色', 'Role', role),
    '',
    label('任务', 'Task', task),
    '',
    label('目标', 'Goal', goal),
  ].join('\n')
}

/** Reject empty / non-string input loudly (the tool argument contract). */
export function assertInput(input: unknown): asserts input is string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('prompt-optimize: instruction must be a non-empty string')
  }
}

/** Bound an over-long instruction so the call stays within budget. */
export function truncateInput(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input
  return `${input.slice(0, maxChars)}\n[原始指令已截断：超出 ${maxChars} 字符的部分被忽略]`
}

/**
 * Heuristic token estimate without a tokenizer: CJK and other wide code points
 * count as ~1.5 tokens each (conservative; actual models use 2-3 for CJK due
 * to UTF-8 byte width), ASCII runs count as one token per four characters.
 * Used as a fallback when the harness `tokenMeter` service is unavailable.
 *
 * Fix (#6): Increased CJK coefficient from 1 to 1.5 to reduce premature
 * truncation. The old coefficient (1) underestimated CJK token usage,
 * causing `maxInputTokens` to cut instructions too aggressively.
 */
export function estimateTokens(text: string): number {
  let wide = 0
  let ascii = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x80) ascii += 1
    else wide += 1
  }
  // CJK chars: ~1.5 tokens each (conservative; actual is 2-3).
  // ASCII: 1 token per 4 chars (standard BPE heuristic).
  return Math.ceil(wide * 1.5) + Math.ceil(ascii / 4)
}

/**
 * Truncate `text` to the longest prefix whose estimated token count is within
 * `maxTokens` (binary search over the cut point), appending `marker` when cut.
 * Shared by the instruction guard (`truncateByTokens`) and the conversation
 * context gatherer — both bound a text block by a token budget.
 * @param text - the text to bound.
 * @param maxTokens - the token budget; `<= 0` disables the guard.
 * @param estimate - token estimator (harness tokenMeter or a heuristic).
 * @param marker - the cut-marker line appended after the truncated prefix.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  estimate: (text: string) => number,
  marker: string,
): string {
  if (maxTokens <= 0 || estimate(text) <= maxTokens) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimate(text.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…\n${marker}`
}

/**
 * Truncate `input` to the longest prefix whose estimated token count is within
 * `maxTokens` (binary search over the cut point). Appends a marker when cut.
 * @param input - the text to bound.
 * @param maxTokens - the token budget; `<= 0` disables the guard.
 * @param estimate - token estimator (harness tokenMeter or a heuristic).
 */
export function truncateByTokens(
  input: string,
  maxTokens: number,
  estimate: (text: string) => number,
): string {
  return truncateToTokenBudget(input, maxTokens, estimate, `[原始指令已截断：超出 ${maxTokens} token 的部分被忽略]`)
}

/** Stable failure message when the model omits one or more sections. */
export const INCOMPLETE_SECTIONS_MESSAGE =
  'optimized prompt is missing one or more required sections (## Role / ## Task / ## Context / ## Format)'

/** Stable failure message when a section body is empty or too short. */
export function thinSectionsMessage(minChars: number): string {
  return `optimized prompt has a section with fewer than ${minChars} meaningful characters`
}

/** Structured diagnosis of a section-style output (missing / too-thin sections). */
export interface SectionDiagnosis {
  /** Required section names whose heading is absent, in canonical order. */
  missing: string[]
  /** Sections whose body has fewer than `minChars` meaningful characters. */
  thin: { name: string; chars: number }[]
}

/**
 * Diagnose a section-style output: which required sections are missing and
 * which are present but too thin. Heading-only when `minChars <= 0` (thin is
 * then always empty). Pure — used to build diagnosis-driven retry feedback.
 */
export function diagnoseSections(text: string, minChars: number): SectionDiagnosis {
  const missing: string[] = []
  const thin: { name: string; chars: number }[] = []
  for (const section of REQUIRED_SECTIONS) {
    if (!getSectionPattern(section, false).test(text)) {
      missing.push(section)
      continue
    }
    if (minChars > 0) {
      const chars = sectionBody(text, section).replace(/\s/g, '').length
      if (chars < minChars) thin.push({ name: section, chars })
    }
  }
  return { missing, thin }
}
