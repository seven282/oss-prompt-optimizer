/** The four required section headings, in canonical order. */
export declare const REQUIRED_SECTIONS: readonly ["Role", "Task", "Context", "Format"];
/** Maximum temperature value from OpenAI API constraints. */
export declare const MAX_TEMPERATURE = 2;
/** Whether every required section heading appears in `text`. */
export declare function hasAllSections(text: string): boolean;
/**
 * Whether `text` already looks like an optimized prompt: all four required
 * sections present under their canonical English heading OR a Chinese-variant
 * heading (`## 角色` / `## 任务` / `## 背景` / `## 输出` etc.), or the
 * Role/Task/Goal labeled form (1.6.5). Used by the
 * `skipIfAlreadyOptimized` pass-through so a re-optimization of an
 * already-structured prompt (in either language) is skipped.
 */
export declare function hasOptimizedSections(text: string): boolean;
/** Whether any of the four section headings appears in `text`. */
export declare function hasSectionHeadings(text: string): boolean;
/**
 * The body text of one section (everything between its heading and the next
 * heading or end), trimmed.
 */
export declare function sectionBody(text: string, section: string): string;
/**
 * Whether every required section is present AND its body contains at least
 * `minChars` non-whitespace characters. `minChars <= 0` falls back to the
 * heading-only check.
 */
export declare function hasValidSections(text: string, minChars: number): boolean;
/**
 * Whether the whole text contains at least `minChars` non-whitespace
 * characters (the plain-style content floor).
 */
export declare function hasSubstantialContent(text: string, minChars: number): boolean;
/**
 * Whether `text` contains alternative heading patterns (non-Markdown)
 * that plain mode should forbid. These are patterns the model might use
 * even when told not to use `## Role` style headings.
 */
export declare function hasAlternativeHeadings(text: string): boolean;
/**
 * Whether a plain-style output is acceptable: at least `minChars`
 * non-whitespace characters AND no four-section headings (the plain style
 * forbids headings; this is the enforcement backstop for the meta-prompt rule).
 * Also checks for alternative heading formats (【】、###、**bold**) that
 * the model may use when explicitly told not to.
 */
export declare function hasPlainOutput(text: string, minChars: number): boolean;
/**
 * Whether `text` contains meta/methodology content beyond the prompt itself.
 *
 * Fix (#2): Only scans the last META_CONTENT_SCAN_TAIL characters to avoid
 * false positives. For example, a prompt that says "分析方法：结论先行、
 * 数据支撑" in the Context section should NOT be flagged as meta content —
 * only appendices like "优化标准：..." or "总结：..." at the end are flagged.
 */
export declare function hasMetaContent(text: string): boolean;
/**
 * Role/Task/Goal labels (1.6.5): the parseable three-element output form.
 * zh: 角色：/任务：/目标：；en: Role:/Task:/Goal:. Either language set is
 * accepted by the validators, so downstream parsing works regardless of the
 * role-document language.
 */
export declare const RTG_LABELS_ZH: readonly ["角色", "任务", "目标"];
export declare const RTG_LABELS_EN: readonly ["Role", "Task", "Goal"];
/** Whether all three Role/Task/Goal labels appear in `text` (zh or en set). */
export declare function hasRoleTaskGoalLabels(text: string): boolean;
/**
 * Whether `text` is a valid Role/Task/Goal output: all three labels present
 * AND every labeled part carries at least `minChars` non-whitespace
 * characters. `minChars <= 0` falls back to the label-only check.
 * Fix (P1a): the "next label" scan only matches real RTG labels — the old
 * `/^[^\n]{0,8}[:：]/` wrongly treated content lines like "分析销售数据趋势："
 * as labels, truncating the body to < minChars.
 */
export declare function hasValidRoleTaskGoal(text: string, minChars: number): boolean;
/**
 * Fold a four-section render into the Role/Task/Goal form (1.6.5):
 * 角色 ← Role, 任务 ← Task, 目标 ← Context + Format merged on one line.
 * Labels follow the render language (zh 角色：/任务：/目标：, en Role:/Task:/Goal:).
 * Lives in validate.ts so both local.ts (local fold) and meta.ts (RTG example
 * folding) can use it without a local↔meta cycle. Pure function.
 */
export declare function toRoleTaskGoal(fourSections: string, en: boolean): string;
/** Reject empty / non-string input loudly (the tool argument contract). */
export declare function assertInput(input: unknown): asserts input is string;
/** Bound an over-long instruction so the call stays within budget. */
export declare function truncateInput(input: string, maxChars: number): string;
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
export declare function estimateTokens(text: string): number;
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
export declare function truncateToTokenBudget(text: string, maxTokens: number, estimate: (text: string) => number, marker: string): string;
/**
 * Truncate `input` to the longest prefix whose estimated token count is within
 * `maxTokens` (binary search over the cut point). Appends a marker when cut.
 * @param input - the text to bound.
 * @param maxTokens - the token budget; `<= 0` disables the guard.
 * @param estimate - token estimator (harness tokenMeter or a heuristic).
 */
export declare function truncateByTokens(input: string, maxTokens: number, estimate: (text: string) => number): string;
/** Structured diagnosis of a section-style output (missing / too-thin sections). */
export interface SectionDiagnosis {
    /** Required section names whose heading is absent, in canonical order. */
    missing: string[];
    /** Sections whose body has fewer than `minChars` meaningful characters. */
    thin: {
        name: string;
        chars: number;
    }[];
}
/**
 * Diagnose a section-style output: which required sections are missing and
 * which are present but too thin. Heading-only when `minChars <= 0` (thin is
 * then always empty). Pure — used to build diagnosis-driven retry feedback.
 */
export declare function diagnoseSections(text: string, minChars: number): SectionDiagnosis;
