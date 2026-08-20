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
 * heading (`## 角色` / `## 任务` / `## 背景` / `## 输出` etc.). Used by the
 * `skipIfAlreadyOptimized` pass-through so a re-optimization of an
 * already-structured prompt (in either language) is skipped.
 */
export function hasOptimizedSections(text: string): boolean {
  return REQUIRED_SECTIONS.every((section) =>
    SECTION_ALIASES[section].some((alias) =>
      new RegExp(`^##\\s*${alias}(?:\\s*[:：]|\\s*$)`, 'm').test(text),
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
 * count as one token each, ASCII runs count as one token per four characters.
 * Used as a fallback when the harness `tokenMeter` service is unavailable.
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
  return wide + Math.ceil(ascii / 4)
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
